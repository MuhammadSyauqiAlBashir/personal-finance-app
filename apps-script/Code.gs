/**
 * Financial Management: sends bank emails from this Gmail to the server.
 *
 * Every 5 minutes it reads threads labelled "bank" (real transactions) and
 * "sample" (examples for building parsers; never recorded), posts the
 * messages to the server, and when the server has accepted them, moves the
 * thread to "processed".
 *
 * Setup: Project Settings > Script Properties > add INGEST_SECRET (from the
 * server). Then run installTrigger() once and allow access.
 */

var ENDPOINT = 'https://financial-management.bashir.my.id/api/ingest/email';
var LABELS = ['bank', 'sample'];
var DONE_LABEL = 'processed';
var THREADS_PER_RUN = 20;
var MESSAGES_PER_REQUEST = 10;

function run() {
  var secret = PropertiesService.getScriptProperties().getProperty('INGEST_SECRET');
  if (!secret) throw new Error('Missing INGEST_SECRET in Project Settings > Script Properties.');

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

// Returns true when the server stored (or already had) every message.
function send_(messages, secret) {
  var payload = JSON.stringify({ messages: messages });
  var ts = Math.floor(Date.now() / 1000).toString();
  var sig = Utilities.computeHmacSha256Signature(ts + '.' + payload, secret, Utilities.Charset.UTF_8);
  var hex = sig.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
  var res = UrlFetchApp.fetch(ENDPOINT, {
    method: 'post',
    contentType: 'application/json; charset=utf-8',
    payload: payload,
    headers: { 'X-Fin-Timestamp': ts, 'X-Fin-Signature': hex },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    console.error('Server answered ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
    return false;
  }
  var results = JSON.parse(res.getContentText()).results || [];
  var bad = results.filter(function (r) { return r.status !== 'stored' && r.status !== 'duplicate'; });
  if (bad.length) console.error('Not stored: ' + JSON.stringify(bad));
  return bad.length === 0 && results.length === messages.length;
}

// Run once: creates the 5-minute trigger (and removes old ones).
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'run') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('run').timeBased().everyMinutes(5).create();
  run();
}
