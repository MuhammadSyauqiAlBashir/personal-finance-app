/**
 * Financial Management: connects this Gmail + Drive to the server.
 *
 * Every 5 minutes:
 *  1. Reads threads labelled "bank" (real transactions) and "sample"
 *     (examples for building parsers; never recorded), posts the messages to
 *     the server, and once accepted moves the thread to "processed".
 *  2. Saves receipt photos of confirmed transactions into this account's
 *     Drive: "Financial Management/Receipts/<YYYY-MM>/".
 *
 * Every request is signed with INGEST_SECRET (HMAC-SHA256).
 *
 * Setup: Project Settings > Script Properties > add INGEST_SECRET (from the
 * server). Then run installTrigger() once and allow access.
 */

var BASE = 'https://financial-management.bashir.my.id';
var ROOT_FOLDER = 'Financial Management';
var LABELS = ['bank', 'sample'];
var DONE_LABEL = 'processed';
var THREADS_PER_RUN = 20;
var MESSAGES_PER_REQUEST = 10;

function run() {
  var secret = PropertiesService.getScriptProperties().getProperty('INGEST_SECRET');
  if (!secret) throw new Error('Missing INGEST_SECRET in Project Settings > Script Properties.');
  sendEmails_(secret);
  saveReceipts_(secret);
}

function sendEmails_(secret) {
  var done = GmailApp.getUserLabelByName(DONE_LABEL) || GmailApp.createLabel(DONE_LABEL);

  LABELS.forEach(function (name) {
    var label = GmailApp.getUserLabelByName(name);
    if (!label) return;
    var threads = label.getThreads(0, THREADS_PER_RUN);
    threads.forEach(function (thread) {
      var messages = thread.getMessages().map(function (m) {
        return {
          id: m.getId(),
          thread_id: thread.getId(),
          sender: m.getFrom(),
          subject: m.getSubject() || '',
          date: m.getDate().toISOString(),
          body: (m.getPlainBody() || '').slice(0, 200000),
          label: name
        };
      });
      var ok = true;
      for (var i = 0; i < messages.length; i += MESSAGES_PER_REQUEST) {
        if (!send_(messages.slice(i, i + MESSAGES_PER_REQUEST), secret)) ok = false;
      }
      if (ok) {
        thread.removeLabel(label);
        thread.addLabel(done);
      }
    });
  });
}

function signed_(signedText, secret) {
  var ts = Math.floor(Date.now() / 1000).toString();
  var sig = Utilities.computeHmacSha256Signature(ts + '.' + signedText, secret, Utilities.Charset.UTF_8);
  var hex = sig.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
  return { 'X-Fin-Timestamp': ts, 'X-Fin-Signature': hex };
}

function get_(path, secret) {
  return UrlFetchApp.fetch(BASE + path, { method: 'get', headers: signed_('GET ' + path, secret), muteHttpExceptions: true });
}

function post_(path, obj, secret) {
  var payload = JSON.stringify(obj);
  return UrlFetchApp.fetch(BASE + path, {
    method: 'post', contentType: 'application/json; charset=utf-8', payload: payload,
    headers: signed_(payload, secret), muteHttpExceptions: true
  });
}

// Returns true when the server stored (or already had) every message.
function send_(messages, secret) {
  var res = post_('/api/ingest/email', { messages: messages }, secret);
  if (res.getResponseCode() !== 200) {
    console.error('Server answered ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
    return false;
  }
  var results = JSON.parse(res.getContentText()).results || [];
  var bad = results.filter(function (r) { return r.status !== 'stored' && r.status !== 'duplicate'; });
  if (bad.length) console.error('Not stored: ' + JSON.stringify(bad));
  return bad.length === 0 && results.length === messages.length;
}

function folderFor_(month) {
  var props = PropertiesService.getScriptProperties();
  var key = 'FOLDER_' + month;
  var id = props.getProperty(key);
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* deleted: recreate */ }
  }
  var root = childFolder_(DriveApp.getRootFolder(), ROOT_FOLDER);
  var folder = childFolder_(childFolder_(root, 'Receipts'), month);
  props.setProperty(key, folder.getId());
  return folder;
}

function childFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function saveReceipts_(secret) {
  var res = get_('/api/ingest/receipts', secret);
  if (res.getResponseCode() !== 200) {
    console.error('Receipt list failed ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
    return;
  }
  (JSON.parse(res.getContentText()).items || []).forEach(function (item) {
    var img = get_('/api/ingest/receipts/' + item.id + '/image', secret);
    if (img.getResponseCode() !== 200) {
      console.error('Receipt ' + item.id + ' download failed: ' + img.getResponseCode());
      return;
    }
    var file = folderFor_(item.folder).createFile(img.getBlob().setName(item.filename));
    var done = post_('/api/ingest/receipts/' + item.id + '/done', { drive_file_id: file.getId() }, secret);
    if (done.getResponseCode() !== 200) console.error('Receipt ' + item.id + ' not marked: ' + done.getContentText());
  });
}

// Run once: creates the 5-minute trigger (and removes old ones).
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'run') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('run').timeBased().everyMinutes(5).create();
  run();
}
