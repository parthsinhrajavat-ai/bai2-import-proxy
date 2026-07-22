// Browser -> this proxy -> Render (parse) + Salesforce Bulk API 2.0 (its own OAuth token).
// The BAI2 file itself never touches Apex - not as a Blob, ContentVersion, or callout body -
// so it isn't subject to Salesforce's 6MB (sync)/12MB (async) Apex callout body limit.
const express = require('express');
const cors = require('cors');
const multer = require('multer');
// Named nodeFetch/NodeFormData (not fetch/FormData) so these don't shadow the built-in global
// fetch/FormData used elsewhere in this file (e.g. sfFetch's calls to Salesforce). node-fetch@2
// and form-data both use Node's classic http/https modules - always HTTP/1.1, no HTTP/2
// negotiation - which sidesteps a Node/undici HTTP2 bug (TypeError: terminated /
// ERR_HTTP2_STREAM_ERROR / NGHTTP2_INTERNAL_ERROR) seen on large multipart uploads to the parser.
const nodeFetch = require('node-fetch');
const NodeFormData = require('form-data');

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

//  Field-mapping logic ported from BAIFileProcessor.cls  

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
    const groups = parsedJson.Groups || [];
    let detailIndex = 0;

    for (const group of groups) {
        const accounts = group.Accounts || [];
        for (const account of accounts) {
            const accountNumber = account.accountNumber;
            const matched = accountNumber ? accountsByNumber[accountNumber] : null;
            if (!matched) {
                continue;
            }
            const details = account.Details || []; // Details can be null
            for (const detail of details) {
                detailIndex++;
                const typeCode = detail.TypeCode;
                const amountRaw = detail.Amount;
                if (!typeCode || amountRaw === undefined || amountRaw === null) {
                    continue;
                }
                // BAI2 amounts are whole cents with no decimal point (e.g. 1221009 = $12,210.09).
                // Math.round before dividing avoids floating point artifacts like 12210.089999999998.
                const amount = Math.round(Number(amountRaw)) / 100;
                if (Number.isNaN(amount)) {
                    continue;
                }
                if (!isCreditTypeCode(typeCode) && !isDebitTypeCode(typeCode)) {
                    continue;
                }

                const customerRef = pickString(detail, ['CustomerReferenceNumber', 'BankReferenceNumber']);
                const text = pickString(detail, ['Text']);
                // Strip the BAI2 line terminator "/" that otherwise leaks onto the end of merchant_name__c.
                const cleanText = text ? text.replace(/\/\s*$/, '').trim() : text;
                const dateRaw = detail.FundsType ? detail.FundsType.date : null;

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

                if (cleanText && cleanText.includes('|')) {
                    const pipeIndex = cleanText.indexOf('|');
                    row.Category__c = cleanText.substring(0, pipeIndex).trim();
                    row.merchant_name__c = cleanText.substring(pipeIndex + 1).trim();
                } else if (cleanText) {
                    row.merchant_name__c = cleanText;
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

// ---------- Parser call (node-fetch@2 + form-data, with retry) ----------

const PARSER_MAX_RETRIES = 2;
const PARSER_RETRY_DELAY_MS = 1000;

// moov-io/bai2 (the Render parser image) expects multipart/form-data with the file under the
// field name "input" - see https://github.com/moov-io/bai2 (`curl --form "input=@...`).
// Only retries network-level failures (the request itself throwing - reset, timeout,
// "terminated", etc.). An HTTP error response (e.g. 400/500) resolves normally instead of
// throwing and is handled separately by the caller, since retrying a real "no" wouldn't help.
async function callParserWithRetry(fileBuffer, fileName) {
    let lastErr;
    for (let attempt = 1; attempt <= PARSER_MAX_RETRIES + 1; attempt++) {
        const parserForm = new NodeFormData();
        parserForm.append('input', fileBuffer, { filename: fileName || 'upload.bai2' });
        try {
            return await nodeFetch(RENDER_PARSER_URL, {
                method: 'POST',
                body: parserForm,
                headers: parserForm.getHeaders()
            });
        } catch (e) {
            lastErr = e;
            if (attempt <= PARSER_MAX_RETRIES) {
                console.error(`[import] stage=render_reached network error on attempt ${attempt}/${PARSER_MAX_RETRIES + 1}, retrying in ${PARSER_RETRY_DELAY_MS}ms: ${e.message}`);
                await new Promise((resolve) => setTimeout(resolve, PARSER_RETRY_DELAY_MS));
            }
        }
    }
    throw lastErr;
}

// ---------- Route ----------

// Every response (success or error) below carries a `stage` field naming exactly where the request 
// dashboard access to this service's own logs.
app.post('/import', upload.single('file'), async (req, res) => {
    const bankId = req.body.bankId;
    const t0 = Date.now();
    const elapsed = () => `${Date.now() - t0}ms`;
    console.log(`[import] stage=received bankId=${bankId} fileName=${req.file && req.file.originalname} size=${req.file && req.file.buffer.length}bytes`);

    try {
        if (!bankId || !SALESFORCE_ID_RE.test(bankId)) {
            console.error(`[import] stage=received FAILED - missing/invalid bankId=${bankId}`);
            return res.status(400).json({ stage: 'received', message: 'Missing or invalid Bank record Id.' });
        }
        if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
            console.error(`[import] stage=received FAILED - no file bytes for bankId=${bankId}`);
            return res.status(400).json({ stage: 'received', message: 'Please choose a file to import.' });
        }

        let auth;
        try {
            auth = buildAuth(req.body.sessionId, req.body.instanceUrl);
            console.log(`[import] stage=auth_validated bankId=${bankId} instanceUrl=${auth.instanceUrl} elapsed=${elapsed()}`);
        } catch (e) {
            console.error(`[import] stage=auth_validated FAILED bankId=${bankId}: ${e.message}`);
            return res.status(400).json({ stage: 'auth_validated', message: e.message });
        }

        let parseRes;
        console.log(`[import] stage=render_reached calling ${RENDER_PARSER_URL} for bankId=${bankId}...`);
        try {
            parseRes = await callParserWithRetry(req.file.buffer, req.file.originalname);
        } catch (e) {
            console.error(`[import] stage=render_reached FAILED bankId=${bankId} elapsed=${elapsed()}:`, e);
            return res.status(502).json({ stage: 'render_reached', message: `Could not reach the BAI2 parsing service (Render). ${e.message}` });
        }
        console.log(`[import] stage=render_reached OK bankId=${bankId} httpStatus=${parseRes.status} elapsed=${elapsed()}`);

        const parseText = await parseRes.text();
        if (!parseRes.ok) {
            console.error(`[import] stage=render_parsed FAILED bankId=${bankId} httpStatus=${parseRes.status}: ${parseText}`);
            return res.status(502).json({ stage: 'render_parsed', message: `BAI2 parser service returned HTTP ${parseRes.status}: ${parseText}` });
        }

        let parsedJson;
        try {
            parsedJson = JSON.parse(parseText);
        } catch (e) {
            console.error(`[import] stage=render_parsed FAILED bankId=${bankId} - response was not valid JSON: ${parseText.slice(0, 500)}`);
            return res.status(502).json({ stage: 'render_parsed', message: 'The parsing service response could not be read.' });
        }
        // console.log(`[import] stage=render_parsed OK bankId=${bankId} groups=${(parsedJson.groups || []).length} elapsed=${elapsed()}`);
        console.log(`[import] stage=render_parsed OK bankId=${bankId} groups=${(parsedJson.Groups || []).length} elapsed=${elapsed()}`);

        const accountsByNumber = await loadAccountsForBank(auth, bankId);
        console.log(`[import] stage=accounts_loaded bankId=${bankId} matched=${Object.keys(accountsByNumber).length} Bank_Account__c record(s) elapsed=${elapsed()}`);

        const rows = buildTransactionRows(parsedJson, accountsByNumber);
        console.log(`[import] stage=rows_built bankId=${bankId} rowCount=${rows.length} elapsed=${elapsed()}`);
        if (rows.length === 0) {
            return res.json({ stage: 'rows_built', jobId: null, recordCount: 0, message: 'No importable transactions found in the parsed file.' });
        }

        const existingIds = await findExistingTransactionIds(auth, rows.map((r) => r.transaction_id__c));
        const toInsert = dedupeRows(rows, existingIds);
        console.log(`[import] stage=dedup_checked bankId=${bankId} newRows=${toInsert.length} alreadyImported=${rows.length - toInsert.length} elapsed=${elapsed()}`);

        if (toInsert.length === 0) {
            return res.json({
                stage: 'dedup_checked',
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
        console.log(`[import] stage=bulk_job_submitted OK bankId=${bankId} jobId=${jobId} rows=${toInsert.length} skipped=${skipped} totalElapsed=${elapsed()}`);

        return res.json({ stage: 'bulk_job_submitted', jobId, recordCount: toInsert.length, message });
    } catch (e) {
        console.error(`[import] stage=unexpected_error bankId=${bankId} elapsed=${elapsed()}:`, e);
        return res.status(500).json({ stage: 'unexpected_error', message: `Unexpected error while importing this file. ${e.message}` });
    }
});

// Polled from the VF page via plain fetch() once /import hands back a jobId - mirrors what 
app.get('/status/:jobId', async (req, res) => {
    const { jobId } = req.params;
    const { sessionId, instanceUrl } = req.query;

    if (!SALESFORCE_ID_RE.test(jobId)) {
        return res.status(400).json({ message: 'Invalid Bulk API job Id.' });
    }

    let auth;
    try {
        auth = buildAuth(sessionId, instanceUrl);
    } catch (e) {
        return res.status(400).json({ message: e.message });
    }

    try {
        const sfRes = await sfFetch(auth, `/services/data/${SF_API_VERSION}/jobs/ingest/${jobId}`);
        const body = await sfRes.json();
        if (!sfRes.ok) {
            return res.status(502).json({ message: `Bulk API status check failed: ${JSON.stringify(body)}` });
        }
        res.json({
            jobId,
            state: body.state,
            numberRecordsProcessed: body.numberRecordsProcessed || 0,
            numberRecordsFailed: body.numberRecordsFailed || 0,
            errorMessage: body.state === 'Failed' ? body.errorMessage : null
        });
    } catch (e) {
        console.error(`[status] jobId=${jobId} FAILED:`, e);
        res.status(500).json({ message: `Unexpected error checking job status. ${e.message}` });
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
