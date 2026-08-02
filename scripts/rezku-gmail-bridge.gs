/**
 * CORNER OPS REZKU GMAIL BRIDGE
 *
 * Script properties required:
 * - CORNER_OPS_URL: your Vercel URL
 * - REZKU_INGEST_SECRET: the same random value configured in Vercel
 */
const CORNER_OPS_REZKU = {
  subject: 'Corner Deli Daily Reports',
  label: 'Corner Ops Rezku Imported',
  searchDays: 14
};

function importRezkuEmailsToCornerOps() {
  const props = PropertiesService.getScriptProperties();
  const appUrl = String(props.getProperty('CORNER_OPS_URL') || '').replace(/\/+$/, '');
  const secret = String(props.getProperty('REZKU_INGEST_SECRET') || '');
  if (!appUrl || !secret) throw new Error('Set CORNER_OPS_URL and REZKU_INGEST_SECRET in Script Properties.');

  const label = GmailApp.getUserLabelByName(CORNER_OPS_REZKU.label) || GmailApp.createLabel(CORNER_OPS_REZKU.label);
  const query = `subject:"${CORNER_OPS_REZKU.subject}" newer_than:${CORNER_OPS_REZKU.searchDays}d -label:"${CORNER_OPS_REZKU.label}"`;
  const threads = GmailApp.search(query);

  threads.forEach(function(thread) {
    let importedFiles = 0;
    let failed = false;

    thread.getMessages().forEach(function(message) {
      const links = extractRezkuLinks_(message.getBody());
      links.forEach(function(link) {
        try {
          const response = UrlFetchApp.fetch(link.url, { method: 'get', followRedirects: true, muteHttpExceptions: true });
          if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
            throw new Error(`Download failed with HTTP ${response.getResponseCode()}`);
          }

          const blob = response.getBlob();
          const contentType = String(blob.getContentType() || '').toLowerCase();
          const fileName = rezkuFileName_(link, message.getDate(), contentType);
          if (contentType.indexOf('pdf') >= 0 || /\.pdf$/i.test(fileName)) return;
          if (!/\.(xlsx|xls)$/i.test(fileName)) return;

          const upload = UrlFetchApp.fetch(appUrl + '/api/rezku/email', {
            method: 'post',
            headers: { 'x-rezku-ingest-secret': secret },
            payload: { reportType: detectRezkuType_(fileName + ' ' + link.text + ' ' + link.url), file: blob.setName(fileName) },
            muteHttpExceptions: true
          });

          if (upload.getResponseCode() < 200 || upload.getResponseCode() >= 300) {
            throw new Error(`Corner Ops rejected ${fileName}: HTTP ${upload.getResponseCode()} ${upload.getContentText()}`);
          }
          importedFiles += 1;
        } catch (error) {
          failed = true;
          console.error(error);
        }
      });
    });

    if (!failed && importedFiles > 0) thread.addLabel(label);
  });
}

function installCornerOpsRezkuTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function(trigger) { return trigger.getHandlerFunction() === 'importRezkuEmailsToCornerOps'; })
    .forEach(function(trigger) { ScriptApp.deleteTrigger(trigger); });
  ScriptApp.newTrigger('importRezkuEmailsToCornerOps').timeBased().everyHours(1).create();
}

function extractRezkuLinks_(html) {
  const output = [];
  const regex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = regex.exec(String(html || ''))) !== null) {
    const url = decodeHtml_(match[1]);
    const text = String(match[2] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (/\.pdf(?:\?|$)/i.test(url)) continue;
    if (/excel|xlsx|xls|labor|shift|attestation|order|transaction|payment/i.test(url + ' ' + text)) output.push({ url: url, text: text });
  }
  return output;
}

function detectRezkuType_(text) {
  const lower = String(text || '').toLowerCase();
  if (/labor|shift|attestation|timecard/.test(lower)) return 'shifts';
  if (/transaction|payment/.test(lower)) return 'transactions';
  if (/order/.test(lower)) return 'orders';
  return '';
}

function rezkuFileName_(link, emailDate, contentType) {
  const stamp = Utilities.formatDate(emailDate, 'America/New_York', 'yyyy-MM-dd_HHmmss');
  let name = String(link.text || '').replace(/[^\w\s.-]/g, '').replace(/\s+/g, '_').slice(0, 90);
  if (!name) name = String(link.url).split('?')[0].split('/').pop() || 'rezku-report';
  name = name.replace(/\.(xlsx|xls)$/i, '');
  const extension = /openxml|xlsx/i.test(contentType + link.url) ? '.xlsx' : '.xls';
  return stamp + '_' + name + extension;
}

function decodeHtml_(value) {
  return String(value || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
