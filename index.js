// Browser -> this proxy -> Render (parse) + Salesforce Bulk API 2.0 (its own OAuth token).
// The BAI2 file itself never touches Apex - not as a Blob, ContentVersion, or callout body -
// so it isn't subject to Salesforce's 6MB (sync)/12MB (async) Apex callout body limit.
const express = require('express');
const cors = require('cors');
const multer = require('multer');

const {
    RENDER_PARSER_URL = 'https://bai2-parser.onrender.com/format',
    SF_API_VERSION = 'v67.0',
    ALLOWED_ORIGIN = '*',
    PORT = 3000
} = process.env;

const MAX_FILE_BYTES = 60 * 1024 * 1024; // headroom above the ~50MB files this needs to support

const app = express();

const allowedOrigins = ALLOWED_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);
app.use(
    cors({
        origin: allowedOrigins.includes('*') ? true : allowedOrigins,
        methods: ['GET', 'POST', 'OPTIONS']
    })
);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES } });

// ---------- Salesforce auth: TEMPORARY quick path ----------
// The browser hands us the running user's own session Id + instance URL per-request (fetched fresh
// from Apex's UserInfo.getSessionId() for every import - see BAIFileProcessor.getSessionContext()).
// This avoids standing up a Connected App, but is NOT scalable/production-safe: a live session token
// is now travelling through the browser to a third-party service, and can be rejected outright
// depending on the org's Session Settings. Swap for the proxy's own Connected App (Client Credentials
// Flow) once this is confirmed working end-to-end - see README notes below for what that involves.

// Only ever call out to a real Salesforce domain with the caller-supplied instanceUrl - without this,
// a caller could pass an arbitrary host and trick the proxy into sending its bearer token elsewhere (SSRF).
const SALESFORCE_HOST_RE = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.(salesforce\.com|force\.com)$/i;

function buildAuth(sessionId, instanceUrl) {
    if (!sessionId || !instanceUrl) {
        throw new Error('Missing Salesforce session context.');
    }
    if (!SALESFORCE_HOST_RE.test(instanceUrl)) {
        throw new Error('Invalid Salesforce instance URL.');
    }
    return { sessionId, instanceUrl };
}

async function sfFetch(auth, path, options = {}) {
    return fetch(`${auth.instanceUrl}${path}`, {
        ...options,
        headers: { ...(options.headers || {}), Authorization: `Bearer ${auth.sessionId}` }
    });
}

// ---------- Field-mapping logic ported from BAIFileProcessor.cls ----------

function typeCodeFamilyDigit(typeCode) {
    if (!typeCode || !/^[0-9]/.test(typeCode)) return null;
    return parseInt(typeCode[0], 10);
}
function isCreditTypeCode(typeCode) {
    const d = typeCodeFamilyDigit(typeCode);
    return d !== null && d >= 1 && d <= 3;
}
function isDebitTypeCode(typeCode) {
    const d = typeCodeFamilyDigit(typeCode);
    return d !== null && d >= 4 && d <= 6;
}

function pickString(detail, keys) {
    for (const key of keys) {
        const val = detail[key];
        if (val !== undefined && val !== null && String(val).trim() !== '') {
            return String(val);
        }
    }
    return null;
}

function isoDate(d) {
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

function todayIso() {
    return isoDate(new Date());
}

// Accepts an ISO date (YYYY-MM-DD) or a raw 6-digit BAI2 date (YYMMDD).
function parseIsoOrBaiDate(raw) {
    if (!raw) return null;
    try {
        if (/^[0-9]{6}$/.test(raw)) {
            const yy = parseInt(raw.substring(0, 2), 10);
            const mm = parseInt(raw.substring(2, 4), 10);
            const dd = parseInt(raw.substring(4, 6), 10);
            const yyyy = yy >= 70 ? 1900 + yy : 2000 + yy;
            return isoDate(new Date(Date.UTC(yyyy, mm - 1, dd)));
        }
        const d = new Date(raw);
        return isNaN(d.getTime()) ? null : isoDate(d);
    } catch (e) {
        return null;
    }
}

// Walks groups -> accounts -> details from the Render /format JSON and builds Transaction__c-shaped rows.
function buildTransactionRows(parsedJson, accountsByNumber) {
    const rows = [];
    const groups = parsedJson.groups || [];
    let detailIndex = 0;

    for (const group of groups) {
        const accounts = group.accounts || [];
        for (const account of accounts) {
            const accountNumber = account.accountNumber;
            const matched = accountNumber ? accountsByNumber[accountNumber] : null;
            if (!matched) {
                continue;
            }
            const details = account.details || [];
            for (const detail of details) {
                detailIndex++;
                const typeCode = detail.typeCode;
                const amountRaw = detail.amount;
                if (!typeCode || amountRaw === undefined || amountRaw === null) {
                    continue;
                }
                const amount = Number(amountRaw);
                if (Number.isNaN(amount)) {
                    continue;
                }
                if (!isCreditTypeCode(typeCode) && !isDebitTypeCode(typeCode)) {
                    continue;
                }

                const customerRef = pickString(detail, ['customerRef', 'reference', 'bankRef', 'id']);
                const text = pickString(detail, ['text', 'description', 'memo']);
                const dateRaw = pickString(detail, ['date', 'valueDate', 'transactionDate']);

                const row = {
                    Bank_Account__c: matched.Id,
                    transaction_type__c: typeCode,
                    transaction_id__c: customerRef || `${accountNumber}-${typeCode}-${amountRaw}-${detailIndex}`,
                    Category__c: '',
                    merchant_name__c: '',
                    Date__c: parseIsoOrBaiDate(dateRaw) || todayIso(),
                    Credit_Amount__c: '',
                    Debit_Amount__c: ''
                };

                if (text && text.includes('|')) {
                    const pipeIndex = text.indexOf('|');
                    row.Category__c = text.substring(0, pipeIndex).trim();
                    row.merchant_name__c = text.substring(pipeIndex + 1).trim();
                } else if (text) {
                    row.merchant_name__c = text;
                }

                if (isCreditTypeCode(typeCode)) {
                    row.Credit_Amount__c = amount;
                } else {
                    row.Debit_Amount__c = amount;
                }

                rows.push(row);
            }
        }
    }
    return rows;
}

function dedupeRows(rows, existingIds) {
    const seen = new Set();
    const toInsert = [];
    for (const row of rows) {
        if (existingIds.has(row.transaction_id__c)) continue;
        if (seen.has(row.transaction_id__c)) continue;
        seen.add(row.transaction_id__c);
        toInsert.push(row);
    }
    return toInsert;
}

// ---------- CSV building (same column order/escaping as the old Apex toCsv()) ----------

const CSV_COLUMNS = [
    'Bank_Account__c',
    'transaction_id__c',
    'transaction_type__c',
    'Category__c',
    'merchant_name__c',
    'Date__c',
    'Credit_Amount__c',
    'Debit_Amount__c'
];

function csvEscape(val) {
    if (val === null || val === undefined || val === '') return '';
    const s = String(val);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
}

function toCsv(rows) {
    const lines = [CSV_COLUMNS.join(',')];
    for (const row of rows) {
        lines.push(CSV_COLUMNS.map((col) => csvEscape(row[col])).join(','));
    }
    return lines.join('\n');
}

// ---------- Salesforce reads (SOQL over REST) ----------

function soqlEscape(val) {
    return String(val).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

const SALESFORCE_ID_RE = /^[a-zA-Z0-9]{15,18}$/;

async function loadAccountsForBank(auth, bankId) {
    const soql = `SELECT Id, Name FROM Bank_Account__c WHERE Bank__c = '${soqlEscape(bankId)}'`;
    const res = await sfFetch(auth, `/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`);
    const body = await res.json();
    if (!res.ok) {
        throw new Error(`Bank_Account__c query failed: ${JSON.stringify(body)}`);
    }
    const map = {};
    for (const rec of body.records || []) {
        if (rec.Name) map[rec.Name] = rec;
    }
    return map;
}

// Batches the "already imported" check so the IN clause never gets too large for one query.
async function findExistingTransactionIds(auth, candidateIds) {
    const found = new Set();
    const unique = [...new Set(candidateIds)];
    const chunkSize = 200;
    for (let i = 0; i < unique.length; i += chunkSize) {
        const chunk = unique.slice(i, i + chunkSize);
        const inList = chunk.map((id) => `'${soqlEscape(id)}'`).join(',');
        const soql = `SELECT transaction_id__c FROM Transaction__c WHERE transaction_id__c IN (${inList})`;
        const res = await sfFetch(auth, `/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`);
        const body = await res.json();
        if (!res.ok) {
            throw new Error(`Transaction__c dedup query failed: ${JSON.stringify(body)}`);
        }
        for (const rec of body.records || []) {
            found.add(rec.transaction_id__c);
        }
    }
    return found;
}

// ---------- Bulk API 2.0: create job -> upload CSV -> close job ----------

async function submitBulkApiJob(auth, rows) {
    const createRes = await sfFetch(auth, `/services/data/${SF_API_VERSION}/jobs/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ object: 'Transaction__c', operation: 'insert', contentType: 'CSV', lineEnding: 'LF' })
    });
    const createBody = await createRes.json();
    if (!createRes.ok || !createBody.id) {
        throw new Error(`Bulk API job creation failed: ${JSON.stringify(createBody)}`);
    }
    const jobId = createBody.id;

    const uploadRes = await sfFetch(auth, `/services/data/${SF_API_VERSION}/jobs/ingest/${jobId}/batches`, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/csv' },
        body: toCsv(rows)
    });
    if (!uploadRes.ok) {
        throw new Error(`Bulk API CSV upload failed: ${await uploadRes.text()}`);
    }

    const closeRes = await sfFetch(auth, `/services/data/${SF_API_VERSION}/jobs/ingest/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: 'UploadComplete' })
    });
    if (!closeRes.ok) {
        throw new Error(`Bulk API job close failed: ${await closeRes.text()}`);
    }

    return jobId;
}

// ---------- Route ----------

app.post('/import', upload.single('file'), async (req, res) => {
    const bankId = req.body.bankId;
    console.log(`[import] request received - bankId=${bankId}, fileName=${req.file && req.file.originalname}, size=${req.file && req.file.buffer.length} bytes`);

    try {
        if (!bankId || !SALESFORCE_ID_RE.test(bankId)) {
            return res.status(400).json({ message: 'Missing or invalid Bank record Id.' });
        }
        if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
            return res.status(400).json({ message: 'Please choose a file to import.' });
        }

        let auth;
        try {
            auth = buildAuth(req.body.sessionId, req.body.instanceUrl);
        } catch (e) {
            return res.status(400).json({ message: e.message });
        }

        let parseRes;
        try {
            parseRes = await fetch(RENDER_PARSER_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/octet-stream' },
                body: req.file.buffer
            });
        } catch (e) {
            console.error(`[import] Render callout failed for bankId=${bankId}:`, e);
            return res.status(502).json({ message: `Could not reach the BAI2 parsing service. ${e.message}` });
        }

        const parseText = await parseRes.text();
        if (!parseRes.ok) {
            console.error(`[import] Render returned HTTP ${parseRes.status} for bankId=${bankId}: ${parseText}`);
            return res.status(502).json({ message: `BAI2 parser service returned HTTP ${parseRes.status}: ${parseText}` });
        }

        let parsedJson;
        try {
            parsedJson = JSON.parse(parseText);
        } catch (e) {
            return res.status(502).json({ message: 'The parsing service response could not be read.' });
        }
        console.log(`[import] Render parse OK for bankId=${bankId}`);

        const accountsByNumber = await loadAccountsForBank(auth, bankId);
        console.log(`[import] matched ${Object.keys(accountsByNumber).length} Bank_Account__c record(s) for bankId=${bankId}`);

        const rows = buildTransactionRows(parsedJson, accountsByNumber);
        if (rows.length === 0) {
            return res.json({ jobId: null, recordCount: 0, message: 'No importable transactions found in the parsed file.' });
        }

        const existingIds = await findExistingTransactionIds(auth, rows.map((r) => r.transaction_id__c));
        const toInsert = dedupeRows(rows, existingIds);

        if (toInsert.length === 0) {
            return res.json({
                jobId: null,
                recordCount: 0,
                message: `All ${rows.length} transaction(s) in this file were already imported previously.`
            });
        }

        const jobId = await submitBulkApiJob(auth, toInsert);
        const skipped = rows.length - toInsert.length;
        let message = `Submitted ${toInsert.length} transaction(s) to Bulk API job ${jobId}.`;
        if (skipped > 0) {
            message += ` ${skipped} already-imported/duplicate transaction(s) skipped.`;
        }
        console.log(`[import] Bulk API job ${jobId} submitted for bankId=${bankId} - ${toInsert.length} row(s), ${skipped} skipped`);

        return res.json({ jobId, recordCount: toInsert.length, message });
    } catch (e) {
        console.error(`[import] Unexpected error for bankId=${bankId}:`, e);
        return res.status(500).json({ message: `Unexpected error while importing this file. ${e.message}` });
    }
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use((err, req, res, next) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ message: `File is too large. Maximum allowed size is ${Math.floor(MAX_FILE_BYTES / (1024 * 1024))}MB.` });
    }
    console.error('[proxy] Unhandled error:', err);
    res.status(500).json({ message: err.message || 'Unexpected server error.' });
});

app.listen(PORT, () => console.log(`bai2-import-proxy listening on port ${PORT}`));
