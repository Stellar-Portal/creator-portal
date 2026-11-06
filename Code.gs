/**
 * Stellar Advocates Portal — a tiny posting log on top of this Google Sheet.
 *
 *  • Creators open their own private link (…/exec?creator=KEY): they see only the
 *    campaigns you put them on, and only their own submitted links.
 *  • The team opens the team link (…/exec?admin=KEY): every campaign, every
 *    creator, every link.
 *
 * All data lives in five tabs of this spreadsheet: Campaigns, Creators,
 * Members, Posts and Logins. You can read or edit them directly at any time.
 * Logins holds account passwords: keep this spreadsheet shared with the core team only.
 */

var TABS = {
  campaigns: { name: 'Campaigns', cols: [
    ['id', 'ID'], ['name', 'Name'], ['artist', 'Artist'], ['sound', 'Sound links (one per line: Name | link)'],
    ['brief', 'Brief'], ['status', 'Status'], ['created', 'Created'], ['deadline', 'Deadline'], ['totalVideos', 'Total videos']] },
  creators: { name: 'Creators', cols: [
    ['id', 'ID'], ['name', 'Name'], ['key', 'Private key'], ['notes', 'Notes'], ['created', 'Created'], ['accounts', 'Accounts'],
    ['tags', 'Groups'], ['email', 'Email'], ['payStart', 'Pay date (repeats monthly)'], ['paidThrough', 'Paid up to'],
    ['push', 'Phone notifications'], ['country', 'Country'], ['quota', 'Monthly video quota']] },
  members: { name: 'Members', cols: [
    ['campaignId', 'Campaign ID'], ['creatorId', 'Creator ID'], ['added', 'Added'], ['videos', 'Videos'], ['notified', 'Emailed']] },
  posts: { name: 'Posts', cols: [
    ['id', 'ID'], ['submitted', 'Submitted'], ['creatorId', 'Creator ID'], ['creator', 'Creator'],
    ['campaignId', 'Campaign ID'], ['campaign', 'Campaign'], ['account', 'Account'], ['link', 'Link'],
    ['postedOn', 'Posted on'], ['views', 'Views'], ['notes', 'Notes'], ['videoId', 'TikTok video ID']] },
  logins: { name: 'Logins', cols: [
    ['id', 'ID'], ['creatorId', 'Creator ID'], ['creator', 'Creator'], ['account', 'Account'], ['login', 'Login (email or phone)'],
    ['password', 'Password'], ['emailPassword', 'Email password'], ['notes', 'Notes'], ['savedAt', 'Saved'], ['savedBy', 'Saved by'],
    ['status', 'Status'], ['request', 'Update request'], ['requestedAt', 'Requested']] }
};

/* Account tracking (filled in every night from ScrapeCreators, see trackAccounts) */
TABS.videos = { name: 'Videos', cols: [
  ['videoId', 'Video ID'], ['creatorId', 'Creator ID'], ['creator', 'Creator'], ['account', 'Account'], ['url', 'Link'],
  ['postedOn', 'Posted on'], ['views', 'Views'], ['likes', 'Likes'], ['comments', 'Comments'], ['shares', 'Shares'], ['saves', 'Saves'],
  ['kind', 'Type'], ['campaignId', 'Campaign ID'], ['campaign', 'Campaign'], ['updated', 'Updated']] };
TABS.accountDays = { name: 'Account history', cols: [
  ['date', 'Date'], ['creatorId', 'Creator ID'], ['account', 'Account'], ['followers', 'Followers'], ['likesTotal', 'Total likes'], ['videoCount', 'Videos on TikTok']] };
var DEFAULT_QUOTA = 28;

/* Login rows: the current one per account is Locked, Unlocked (the creator may send new details once)
   or Update requested. Replaced versions stay in the tab as "Old version". */
var LOGIN_STATUS = { locked: 'Locked', open: 'Unlocked', requested: 'Update requested', old: 'Old version' };

var MAX_LINKS_PER_SUBMIT = 20;
/* The page checks this, so it can say when the script needs redeploying (Deploy → Manage deployments → New version). */
var VERSION = '2026-11-06.1';

/* ───────────────────────── Web app entry ───────────────────────── */

function doGet(e) {
  var p = (e && e.parameter) || {};
  // Once the page lives elsewhere (e.g. GitHub Pages), old Google links point people there.
  var app = webAppUrl_();
  if (app && !/^https:\/\/script\.google\.com\//.test(app)) {
    var dest = app + (p.admin ? '?admin=' + encodeURIComponent(p.admin) : p.creator ? '?creator=' + encodeURIComponent(p.creator) : '');
    return HtmlService.createHtmlOutput('<div style="font:16px/1.5 system-ui,sans-serif;padding:32px 20px;max-width:460px;margin:auto;text-align:center">' +
      '<p style="font-weight:600;font-size:20px;margin:0 0 8px">Stellar Advocates Portal has moved</p>' +
      '<p style="margin:0 0 20px;color:#555">Please use the new link from now on.</p>' +
      '<a href="' + esc_(dest) + '" target="_top" style="display:inline-block;background:#0626c7;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">Open Advocates Portal</a></div>')
      .setTitle('Stellar Advocates Portal').addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  var boot = { mode: 'none' };
  if (p.admin) boot = { mode: 'admin', key: String(p.admin) };
  else if (p.creator) boot = { mode: 'creator', key: String(p.creator) };
  var t = HtmlService.createTemplateFromFile('Index');
  t.boot = JSON.stringify(boot).replace(/</g, '\\u003c');
  return t.evaluate()
    .setTitle('Stellar Advocates Portal')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * JSON API used by the page when it is hosted outside Google (e.g. GitHub Pages).
 * The page POSTs {fn, args} as plain text without Google cookies, so visitors are never
 * mixed up with whatever Google accounts they're signed into.
 */
function doPost(e) {
  var out;
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var fn = API_[body.fn];
    if (!fn) throw new Error('Unknown request.');
    var t0 = Date.now();
    out = { ok: true, data: fn.apply(null, Array.isArray(body.args) ? body.args : []) };
    console.log(body.fn + ' took ' + (Date.now() - t0) + ' ms');   // visible in Apps Script → Executions
  } catch (err) {
    out = { ok: false, error: (err && err.message) || String(err) };
    console.error((body && body.fn) + ' failed: ' + out.error);
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/* ───────────────────────── Creator API ───────────────────────── */

function creatorView(key) {
  var me = creatorByKey_(key);
  var campaignIds = {}, myVideos = {}, added = {};
  read_('members').forEach(function (m) { if (m.creatorId === me.id) { campaignIds[m.campaignId] = true; myVideos[m.campaignId] = m.videos; added[m.campaignId] = m.added; } });
  var campaigns = read_('campaigns').filter(function (c) { return campaignIds[c.id]; });
  var names = {};
  campaigns.forEach(function (c) { names[c.id] = c.name; });
  var accounts = parseAccounts_(me.accounts), used = [];
  var posts = read_('posts')
    .filter(function (p) { return p.creatorId === me.id; })
    .map(function (p) {
      if (p.account) used.push(p.account);
      return { id: p.id, campaignId: p.campaignId, campaign: names[p.campaignId] || p.campaign,
        account: p.account, link: p.link, postedOn: p.postedOn, submitted: p.submitted };
    })
    .sort(byPostedDesc_);
  var allAccounts = parseAccounts_(accounts.concat(used));
  return {
    version: VERSION,
    name: me.name,
    email: me.email || '',
    campaigns: campaigns.map(function (c) {
      // Only this creator's own amount: never the campaign total or anyone else's
      return { id: c.id, name: c.name, artist: c.artist, sounds: parseSounds_(c.sound), brief: c.brief, status: c.status || 'Active',
        deadline: c.deadline || '', myVideos: myVideos[c.id] || '', added: added[c.id] || '' };
    }),
    posts: posts,
    accounts: allAccounts,
    // Phone notifications (OneSignal): the app id is public; pushId is only known to whoever holds this private link
    push: pushConfig_().appId ? { appId: pushConfig_().appId, id: pushId_(me), on: /^On/.test(me.push || '') } : null,
    // Whether each login was sent and its lock state. Never the login details themselves.
    logins: currentLogins_(read_('logins'), me.id).map(function (l) {
      return { account: l.account, status: loginKey_(l.status), savedAt: l.savedAt, request: l.request };
    })
  };
}

/** A creator sends the login for one of their accounts. After that it's locked: they can't see or change it. */
function creatorSaveLogin(key, f) {
  return withLock_(function () {
    var me = creatorByKey_(key);
    f = f || {};
    var account = clean_(f.account, 60).replace(/^@+/, '');
    if (!account) throw new Error('Pick which account this login is for.');
    var login = clean_(f.login, 200), pw = String(f.password == null ? '' : f.password).slice(0, 200);
    if (!login) throw new Error('Add the email or phone number you log in with.');
    if (!pw.trim()) throw new Error('Add the password.');
    var cur = currentLogins_(read_('logins'), me.id).filter(function (l) { return lower_(l.account) === lower_(account); })[0];
    if (cur && cur.status !== LOGIN_STATUS.open)
      throw new Error('The login for @' + account + ' is locked. If you changed the password, tap “I changed my password” and the team will unlock it.');
    if (cur) update_('logins', merge_(cur, { status: LOGIN_STATUS.old }));
    appendMany_('logins', [{ id: newId_('l'), creatorId: me.id, creator: me.name, account: account, login: login, password: pw,
      emailPassword: String(f.emailPassword == null ? '' : f.emailPassword).slice(0, 200), notes: clean_(f.notes, 1000),
      savedAt: stamp_(), savedBy: 'Creator', status: LOGIN_STATUS.locked, request: '', requestedAt: '' }]);
    var saved = parseAccounts_(me.accounts), more = parseAccounts_(saved.concat([account]));
    if (more.length !== saved.length) update_('creators', merge_(me, { accounts: more.join(', ') }));
    return creatorView(key);
  });
}

/** "I changed my password": asks the team to unlock that login so the creator can send the new one. */
function creatorRequestUnlock(key, account, note) {
  var res = withLock_(function () {
    var me = creatorByKey_(key);
    var cur = currentLogins_(read_('logins'), me.id).filter(function (l) { return lower_(l.account) === lower_(account); })[0];
    if (!cur) throw new Error('There’s no saved login for that account yet.');
    var changed = cur.status === LOGIN_STATUS.locked;
    if (changed) update_('logins', merge_(cur, { status: LOGIN_STATUS.requested, request: clean_(note, 300), requestedAt: stamp_() }));
    return { me: me, account: cur.account, note: clean_(note, 300), changed: changed };
  });
  if (res.changed) notifyTeam_('Login update request: ' + res.me.name + ' (@' + res.account + ')',
    res.me.name + ' says they changed the password for @' + res.account + '.' + (res.note ? '\n\nTheir note: ' + res.note : '') +
    '\n\nOpen the team dashboard → Creators → ' + res.me.name + ' and click Unlock so they can send the new login.');
  return creatorView(key);
}

/** The page reports whether this phone/browser is subscribed to notifications, so the team can see it. */
function creatorSetPush(key, on) {
  return withLock_(function () {
    var me = creatorByKey_(key);
    var val = on ? (/^On/.test(me.push || '') ? me.push : 'On since ' + today_()) : 'Off';
    if (val !== me.push) update_('creators', merge_(me, { push: val }));
    return { on: !!on };
  });
}

/** Creators can add the email they want campaign alerts sent to. */
function creatorSaveEmail(key, email) {
  return withLock_(function () {
    var me = creatorByKey_(key);
    var em = clean_(email, 200);
    if (em && !isEmail_(em)) throw new Error('That doesn’t look like an email address.');
    update_('creators', merge_(me, { email: em }));
    return creatorView(key);
  });
}

function submitPosts(key, campaignId, items) {
  return withLock_(function () {
    var me = creatorByKey_(key);
    var campaign = find_('campaigns', function (c) { return c.id === campaignId; });
    var isMember = campaign && read_('members').some(function (m) {
      return m.creatorId === me.id && m.campaignId === campaignId;
    });
    if (!isMember) throw new Error('Pick one of your campaigns first.');
    if ((campaign.status || 'Active') !== 'Active') throw new Error('This campaign has ended, so it no longer takes new links.');
    if (!items || !items.length) throw new Error('Add at least one link.');
    if (items.length > MAX_LINKS_PER_SUBMIT) throw new Error('You can send up to ' + MAX_LINKS_PER_SUBMIT + ' links at a time.');

    var seen = {};
    read_('posts').forEach(function (p) { seen[normLink_(p.link)] = true; });
    var rows = [], skipped = [];
    var now = stamp_();
    items.forEach(function (it) {
      var link = String((it && it.link) || '').trim();
      var date = String((it && it.date) || '').trim();
      var account = String((it && it.account) || '').trim().replace(/^@+/, '').slice(0, 60);
      if (!/^https?:\/\/\S+$/i.test(link) || link.length > 500) { skipped.push({ link: link, reason: 'Not a valid link' }); return; }
      if (!isIsoDate_(date)) { skipped.push({ link: link, reason: 'Missing the date it was posted' }); return; }
      if (date > addDays_(today_(), 1)) { skipped.push({ link: link, reason: 'Date is in the future' }); return; }
      var n = normLink_(link);
      if (seen[n]) { skipped.push({ link: link, reason: 'Already submitted' }); return; }
      seen[n] = true;
      rows.push({ id: newId_('p'), submitted: now, creatorId: me.id, creator: me.name,
        campaignId: campaign.id, campaign: campaign.name, account: account, link: link,
        postedOn: date, views: '', notes: '' });
    });
    appendMany_('posts', rows);
    var saved = parseAccounts_(me.accounts);
    var more = parseAccounts_(saved.concat(rows.map(function (r) { return r.account; })));
    if (more.length !== saved.length) update_('creators', merge_(me, { accounts: more.join(', ') }));
    return { added: rows.length, skipped: skipped, view: creatorView(key) };
  });
}

/** Lets a creator fix the date or account on a link they already sent (their own links only). */
function updateMyPost(key, postId, fields) {
  return withLock_(function () {
    var me = creatorByKey_(key);
    var post = find_('posts', function (p) { return p.id === postId && p.creatorId === me.id; });
    if (!post) throw new Error('That post no longer exists.');
    var patch = {};
    if (fields && 'postedOn' in fields) {
      var d = String(fields.postedOn || '').trim();
      if (!isIsoDate_(d)) throw new Error('Add the date it was posted.');
      if (d > addDays_(today_(), 1)) throw new Error('The date can’t be in the future.');
      patch.postedOn = d;
    }
    if (fields && 'account' in fields) patch.account = clean_(fields.account, 60).replace(/^@+/, '');
    update_('posts', merge_(post, patch));
    if (patch.account) {
      var saved = parseAccounts_(me.accounts), more = parseAccounts_(saved.concat([patch.account]));
      if (more.length !== saved.length) update_('creators', merge_(me, { accounts: more.join(', ') }));
    }
    return creatorView(key);
  });
}

function deleteMyPost(key, postId) {
  return withLock_(function () {
    var me = creatorByKey_(key);
    var post = find_('posts', function (p) { return p.id === postId && p.creatorId === me.id; });
    if (post) deleteRow_('posts', post._row);
    return creatorView(key);
  });
}

/* ───────────────────────── Team API ───────────────────────── */

function adminView(key) {
  requireAdmin_(key);
  var base = webAppUrl_();
  var posts = read_('posts'), used = {}, logins = read_('logins'), today = today_();
  var track = trackingInfo_(), videos = track.on ? read_('videos') : [], members = read_('members');
  posts.forEach(function (p) { if (p.account) (used[p.creatorId] = used[p.creatorId] || []).push(p.account); });
  var props = P_();
  return {
    version: VERSION,
    baseUrl: base,
    pinSet: !!props.getProperty('LOGINS_PIN_HASH'),
    pushReady: !!pushConfig_().apiKey,
    tracking: track,
    remindersTo: props.getProperty('REMINDERS_ON') ? (props.getProperty('NOTIFY_EMAIL') || '') : '',
    campaigns: read_('campaigns').map(function (c) {
      return { id: c.id, name: c.name, artist: c.artist, sounds: parseSounds_(c.sound), brief: c.brief,
        status: c.status || 'Active', created: c.created, deadline: c.deadline, totalVideos: c.totalVideos };
    }),
    creators: read_('creators').map(function (c) {
      return { id: c.id, name: c.name, notes: c.notes, accounts: parseAccounts_(parseAccounts_(c.accounts).concat(used[c.id] || [])),
        link: base ? base + '?creator=' + c.key : '', created: c.created,
        tags: parseTags_(c.tags), email: c.email || '', payStart: c.payStart || '', pay: payInfo_(c, today), push: c.push || '', country: c.country || '', quota: c.quota || '',
        perf: track.on ? creatorPerf_(c, videos, today) : null,
        campaignsJoined: members.filter(function (m) { return m.creatorId === c.id; }).length,
        commissioned: posts.filter(function (p) { return p.creatorId === c.id; }).length,
        // Lock state only: the details themselves need the logins PIN (adminLogins)
        logins: currentLogins_(logins, c.id).map(function (l) {
          return { id: l.id, account: l.account, status: loginKey_(l.status), savedAt: l.savedAt, savedBy: l.savedBy,
            request: l.request, requestedAt: l.requestedAt };
        }) };
    }),
    members: members.map(function (m) {
      return { campaignId: m.campaignId, creatorId: m.creatorId, added: m.added, videos: m.videos, notified: m.notified };
    }),
    posts: posts.map(function (p) {
      return { id: p.id, submitted: p.submitted, creatorId: p.creatorId, creator: p.creator,
        campaignId: p.campaignId, campaign: p.campaign, account: p.account, link: p.link,
        postedOn: p.postedOn, views: p.views, notes: p.notes };
    }).sort(byPostedDesc_)
  };
}

function adminSaveCampaign(key, c) {
  requireAdmin_(key);
  return withLock_(function () {
    var name = clean_(c && c.name, 120);
    if (!name) throw new Error('Give the campaign a name.');
    var status = (c.status === 'Ended') ? 'Ended' : 'Active';
    var existing = c.id ? find_('campaigns', function (x) { return x.id === c.id; }) : null;
    // A field that isn't sent keeps its current value
    var deadline = c.deadline === undefined ? (existing ? existing.deadline : '') : clean_(c.deadline, 10);
    if (deadline && !isIsoDate_(deadline)) throw new Error('Pick a valid deadline date.');
    var total = toCount_(c.totalVideos === undefined ? (existing ? existing.totalVideos : '') : c.totalVideos, 'Total videos');
    var sounds = c.sounds !== undefined ? checkSounds_(c.sounds) : c.sound !== undefined ? parseSounds_(c.sound) : parseSounds_(existing ? existing.sound : '');
    var fields = { name: name, artist: clean_(c.artist, 120), sound: soundsCell_(sounds),
      brief: clean_(c.brief, 4000), status: status, deadline: deadline, totalVideos: total === '' ? '' : String(total) };

    // Who's on it, and how many videos each (sent together from the campaign editor)
    var list = null;
    if (Array.isArray(c.members)) {
      var known = {}, seen = {}, sum = 0;
      read_('creators').forEach(function (cr) { known[cr.id] = cr; });
      list = [];
      c.members.forEach(function (m) {
        var id = String((m && m.creatorId) || '');
        if (!id || seen[id]) return;
        if (!known[id]) throw new Error('One of the creators you picked no longer exists. Reload and try again.');
        seen[id] = true;
        var v = toCount_(m.videos, 'Amount of videos for ' + known[id].name);
        if (v !== '') sum += v;
        list.push({ creatorId: id, videos: v === '' ? '' : String(v) });
      });
      if (total !== '' && sum > total)
        throw new Error('You’ve assigned ' + sum + ' videos, but the campaign total is ' + total + '. Lower someone’s amount or raise the total.');
    }

    var id = c.id;
    if (id) {
      var row = find_('campaigns', function (x) { return x.id === id; });
      if (!row) throw new Error('That campaign no longer exists.');
      update_('campaigns', merge_(row, fields));
    } else {
      id = fields.id = newId_('c'); fields.created = today_();
      appendMany_('campaigns', [fields]);
    }
    if (list) {
      var keep = {};
      list.forEach(function (m) { keep[m.creatorId] = m; });
      deleteWhere_('members', function (m) { return m.campaignId === id && !keep[m.creatorId]; });
      var have = {};
      read_('members').forEach(function (m) {
        if (m.campaignId !== id) return;
        have[m.creatorId] = true;
        if (String(m.videos) !== keep[m.creatorId].videos) update_('members', merge_(m, { videos: keep[m.creatorId].videos }));
      });
      var fresh = list.filter(function (m) { return !have[m.creatorId]; });
      // Newly added creators get an email (when asked for, the campaign is Active and they have an address)
      var sent = c.notify === true && status === 'Active'
        ? notifyNewMembers_(merge_(fields, { id: id }), fresh) : { results: {}, sent: [], noEmail: [], failed: [], pushed: [] };
      appendMany_('members', fresh.map(function (m) {
        return { campaignId: id, creatorId: m.creatorId, added: today_(), videos: m.videos, notified: sent.results[m.creatorId] || '' };
      }));
    }
    var view = adminView(key);
    if (sent) view.emailed = { sent: sent.sent, noEmail: sent.noEmail, failed: sent.failed, pushed: sent.pushed };
    return view;
  });
}

/**
 * Tells each newly added creator: a phone notification (if they turned those on) and an email
 * (campaign name, their own amount, deadline and their private link).
 */
function notifyNewMembers_(campaign, fresh) {
  var out = { results: {}, sent: [], noEmail: [], failed: [], pushed: [] };
  if (!fresh.length) return out;
  var byId = {}, base = webAppUrl_();
  read_('creators').forEach(function (cr) { byId[cr.id] = cr; });
  fresh.forEach(function (m) {
    var cr = byId[m.creatorId]; if (!cr) return;
    var pushed = false;
    if (/^On/.test(cr.push || '')) {
      var facts2 = [m.videos ? plainPlural_(+m.videos, 'video') : '', campaign.deadline ? 'deadline ' + longDate_(campaign.deadline) : ''].filter(String);
      pushed = sendPush_(cr, 'New campaign: ' + campaign.name,
        'You’ve been added' + (facts2.length ? ' · ' + facts2.join(' · ') : '') + '. Tap to see the brief and the sounds.', 'campaign-' + campaign.id).ok;
      if (pushed) out.pushed.push(cr.name);
    }
    if (!isEmail_(cr.email)) { out.noEmail.push(cr.name); out.results[cr.id] = pushed ? 'Phone notification' : 'No email'; return; }
    var link = base ? base + '?creator=' + cr.key : '';
    var first = String(cr.name).split(/\s+/)[0];
    var facts = [m.videos ? 'Your videos: ' + m.videos : '', campaign.deadline ? 'Deadline: ' + longDate_(campaign.deadline) : ''].filter(String);
    var title = campaign.name + (campaign.artist ? ' (' + campaign.artist + ')' : '');
    var body = 'Hi ' + first + ',\n\nYou’ve been added to a new Stellar campaign: ' + title + '.\n' +
      (facts.length ? '\n' + facts.join('\n') + '\n' : '') +
      (link ? '\nOpen your portal to see the brief and the sounds:\n' + link + '\n' : '') + '\nStellar';
    var html = '<div style="font:15px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#15161b;max-width:480px">' +
      '<p>Hi ' + esc_(first) + ',</p><p>You’ve been added to a new Stellar campaign: <b>' + esc_(title) + '</b>.</p>' +
      (facts.length ? '<p>' + facts.map(esc_).join('<br>') + '</p>' : '') +
      (link ? '<p><a href="' + esc_(link) + '" style="display:inline-block;background:#0626c7;color:#fff;padding:11px 18px;border-radius:8px;text-decoration:none;font-weight:600">Open your portal</a></p>' +
        '<p style="color:#5d6170;font-size:13px">The brief and the sounds are in the Campaigns tab.</p>' : '') + '<p>Stellar</p></div>';
    try {
      MailApp.sendEmail({ to: cr.email, subject: 'New campaign: ' + campaign.name, body: body, htmlBody: html, name: 'Stellar Advocates Portal' });
      out.sent.push(cr.name); out.results[cr.id] = stamp_() + (pushed ? ' + phone' : '');
    } catch (e) { out.failed.push(cr.name); out.results[cr.id] = pushed ? 'Phone notification' : 'Not sent'; }
  });
  return out;
}

function adminDeleteCampaign(key, campaignId) {
  requireAdmin_(key);
  return withLock_(function () {
    if (read_('posts').some(function (p) { return p.campaignId === campaignId; }))
      throw new Error('This campaign has posts. Mark it as Ended instead so the links are kept.');
    deleteWhere_('members', function (m) { return m.campaignId === campaignId; });
    deleteWhere_('campaigns', function (c) { return c.id === campaignId; });
    return adminView(key);
  });
}

function adminSaveCreator(key, c) {
  requireAdmin_(key);
  return withLock_(function () {
    var name = clean_(c && c.name, 80);
    if (!name) throw new Error('Add the creator’s name.');
    var patch = { name: name };
    if (c.notes !== undefined) patch.notes = clean_(c.notes, 500);
    if (c.accounts !== undefined) patch.accounts = parseAccounts_(c.accounts).join(', ');
    if (c.tags !== undefined) patch.tags = parseTags_(c.tags).join(', ');
    if (c.email !== undefined) {
      var em = clean_(c.email, 200);
      if (em && !isEmail_(em)) throw new Error('That email address doesn’t look right.');
      patch.email = em;
    }
    if (c.country !== undefined) patch.country = clean_(c.country, 60);
    if (c.quota !== undefined) {
      var q = String(c.quota).trim();
      if (q && !(/^\d{1,3}$/.test(q) && +q > 0)) throw new Error('The monthly quota should be a number, like 28.');
      patch.quota = q;
    }
    if (c.payStart !== undefined) {
      var ps = clean_(c.payStart, 10);
      if (ps && !isIsoDate_(ps)) throw new Error('Pick a valid pay date.');
      patch.payStart = ps;
    }
    if (c.id) {
      var row = find_('creators', function (x) { return x.id === c.id; });
      if (!row) throw new Error('That creator no longer exists.');
      if (patch.payStart !== undefined && patch.payStart !== row.payStart) patch.paidThrough = ''; // new pay date: start counting from it
      update_('creators', merge_(row, patch));
    } else {
      appendMany_('creators', [merge_({ id: newId_('cr'), key: newKey_(), notes: '', created: today_(), accounts: '' }, patch)]);
    }
    return adminView(key);
  });
}

/** Payments: "next" marks the oldest unpaid month as paid; "undo" steps back one month. */
function adminSetPaid(key, creatorId, action) {
  requireAdmin_(key);
  return withLock_(function () {
    var row = find_('creators', function (x) { return x.id === creatorId; });
    if (!row) throw new Error('That creator no longer exists.');
    var p = payInfo_(row, today_());
    if (!p) throw new Error('Add a pay date for ' + row.name + ' first.');
    if (action === 'undo') { if (!p.lastPaid) throw new Error('Nothing to undo.'); update_('creators', merge_(row, { paidThrough: p.beforeLast })); }
    else update_('creators', merge_(row, { paidThrough: p.next }));
    return adminView(key);
  });
}

/** Unlock a login so the creator can send new details once (it locks again when they do), or lock it again. */
function adminSetLoginStatus(key, loginId, open) {
  requireAdmin_(key);
  return withLock_(function () {
    var row = find_('logins', function (l) { return l.id === loginId; });
    if (!row || row.status === LOGIN_STATUS.old) throw new Error('That login has changed. Reload the page.');
    update_('logins', merge_(row, open ? { status: LOGIN_STATUS.open } : { status: LOGIN_STATUS.locked, request: '', requestedAt: '' }));
    return adminView(key);
  });
}

/** The saved logins of one creator, including older versions. Needs the logins PIN. */
function adminLogins(key, pin, creatorId) {
  requireAdmin_(key);
  checkPin_(pin);
  // Per account: newest first (later rows in the tab are newer)
  return read_('logins').filter(function (l) { return l.creatorId === creatorId; })
    .sort(function (a, b) { return lower_(a.account).localeCompare(lower_(b.account)) || b._row - a._row; })
    .map(function (l) {
      return { id: l.id, account: l.account, login: l.login, password: l.password, emailPassword: l.emailPassword, notes: l.notes,
        savedAt: l.savedAt, savedBy: l.savedBy, status: loginKey_(l.status) };
    });
}

/** The team types in a login (e.g. a creator sent the new password by message). Older version is kept. */
function adminSaveLogin(key, pin, creatorId, f) {
  requireAdmin_(key);
  checkPin_(pin);
  withLock_(function () {
    var cr = find_('creators', function (x) { return x.id === creatorId; });
    if (!cr) throw new Error('That creator no longer exists.');
    f = f || {};
    var account = clean_(f.account, 60).replace(/^@+/, '');
    if (!account) throw new Error('Add the account name.');
    var cur = currentLogins_(read_('logins'), cr.id).filter(function (l) { return lower_(l.account) === lower_(account); })[0];
    if (cur) update_('logins', merge_(cur, { status: LOGIN_STATUS.old }));
    appendMany_('logins', [{ id: newId_('l'), creatorId: cr.id, creator: cr.name, account: account, login: clean_(f.login, 200),
      password: String(f.password == null ? '' : f.password).slice(0, 200), emailPassword: String(f.emailPassword == null ? '' : f.emailPassword).slice(0, 200),
      notes: clean_(f.notes, 1000), savedAt: stamp_(), savedBy: 'Team', status: LOGIN_STATUS.locked, request: '', requestedAt: '' }]);
    var saved = parseAccounts_(cr.accounts), more = parseAccounts_(saved.concat([account]));
    if (more.length !== saved.length) update_('creators', merge_(cr, { accounts: more.join(', ') }));
  });
  return { view: adminView(key), logins: adminLogins(key, pin, creatorId) };
}

function adminResetLink(key, creatorId) {
  requireAdmin_(key);
  return withLock_(function () {
    var row = find_('creators', function (x) { return x.id === creatorId; });
    if (!row) throw new Error('That creator no longer exists.');
    update_('creators', merge_(row, { key: newKey_() }));
    return adminView(key);
  });
}

/**
 * Offboarding: removes the creator from the Creators list and from every campaign, and their private link stops working.
 * Their posted links stay in the campaigns (so the numbers don't change) and their saved logins stay in the Logins tab.
 */
function adminDeleteCreator(key, creatorId) {
  requireAdmin_(key);
  return withLock_(function () {
    if (!find_('creators', function (c) { return c.id === creatorId; })) throw new Error('That creator no longer exists.');
    deleteWhere_('members', function (m) { return m.creatorId === creatorId; });
    deleteWhere_('creators', function (c) { return c.id === creatorId; });
    return adminView(key);
  });
}

function adminSetMember(key, campaignId, creatorId, on) {
  requireAdmin_(key);
  return withLock_(function () {
    var exists = read_('members').some(function (m) { return m.campaignId === campaignId && m.creatorId === creatorId; });
    if (on && !exists) {
      if (!find_('campaigns', function (c) { return c.id === campaignId; }) ||
          !find_('creators', function (c) { return c.id === creatorId; })) throw new Error('That campaign or creator no longer exists.');
      appendMany_('members', [{ campaignId: campaignId, creatorId: creatorId, added: today_() }]);
    }
    if (!on && exists) deleteWhere_('members', function (m) { return m.campaignId === campaignId && m.creatorId === creatorId; });
    return adminView(key);
  });
}

function adminUpdatePost(key, postId, fields) {
  requireAdmin_(key);
  return withLock_(function () {
    var row = find_('posts', function (p) { return p.id === postId; });
    if (!row) throw new Error('That post no longer exists.');
    var patch = {};
    if (fields && 'views' in fields) patch.views = clean_(fields.views, 40);
    if (fields && 'notes' in fields) patch.notes = clean_(fields.notes, 500);
    update_('posts', merge_(row, patch));
    return adminView(key);
  });
}

function adminDeletePost(key, postId) {
  requireAdmin_(key);
  return withLock_(function () {
    deleteWhere_('posts', function (p) { return p.id === postId; });
    return adminView(key);
  });
}

/** Sends a test notification to one creator's phone. */
function adminTestPush(key, creatorId) {
  requireAdmin_(key);
  var cr = find_('creators', function (x) { return x.id === creatorId; });
  if (!cr) throw new Error('That creator no longer exists.');
  if (!pushConfig_().apiKey) throw new Error('Phone notifications aren’t set up yet. In the Google Sheet: Advocates Portal → Set up phone notifications.');
  var r = sendPush_(cr, 'Test from Stellar', 'Notifications are working (sent ' + Utilities.formatDate(new Date(), tz_(), 'HH:mm') + '). You’ll get one like this when you’re added to a campaign.', 'test-' + Utilities.getUuid().slice(0, 8));
  if (!r.ok) throw new Error(r.error || 'Couldn’t send it.');
  return { ok: true };
}

/* ───────────────────────── Phone notifications (OneSignal) ───────────────────────── */

function pushConfig_() {
  var p = P_();
  return { appId: p.getProperty('PUSH_APP_ID') || '', apiKey: p.getProperty('PUSH_API_KEY') || '' };
}
/** A stable id for OneSignal that can't be guessed: it comes from the creator's private key, so "New link" also cuts off notifications. */
function pushId_(cr) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'push:' + cr.key, Utilities.Charset.UTF_8);
  return 'adv_' + bytes.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('').slice(0, 32);
}
/** {ok, error}. Never throws. The link in the notification is the plain page: the phone already knows its creator link. */
function sendPush_(cr, heading, text, topic) {
  var cfg = pushConfig_();
  if (!cfg.appId || !cfg.apiKey) return { ok: false, error: 'Phone notifications aren’t set up.' };
  var base = webAppUrl_();
  var body = { app_id: cfg.appId, target_channel: 'push', include_aliases: { external_id: [pushId_(cr)] },
    headings: { en: heading }, contents: { en: text },
    // Without a topic, a new web notification silently replaces the previous one if it hasn't been opened yet
    web_push_topic: String(topic || ('n-' + Utilities.getUuid().slice(0, 8))).slice(0, 60) };
  if (/^https:\/\//.test(base) && !/^https:\/\/script\.google\.com\//.test(base)) body.url = base + '#campaigns';
  try {
    var res = UrlFetchApp.fetch('https://api.onesignal.com/notifications?c=push', { method: 'post', contentType: 'application/json',
      headers: { Authorization: 'Key ' + cfg.apiKey }, payload: JSON.stringify(body), muteHttpExceptions: true });
    var code = res.getResponseCode(), j = {};
    try { j = JSON.parse(res.getContentText() || '{}'); } catch (e) {}
    if (code >= 200 && code < 300 && j.id) return { ok: true };
    var err = (j.errors && (Array.isArray(j.errors) ? j.errors.join(' ') : JSON.stringify(j.errors))) || ('OneSignal answered ' + code);
    if (/not subscribed/i.test(err)) err = cr.name + ' hasn’t turned on notifications on their phone (or turned them off).';
    else if (code === 401 || code === 403) err = 'OneSignal didn’t accept the API key. Run Advocates Portal → Set up phone notifications again.';
    return { ok: false, error: err };
  } catch (e) { return { ok: false, error: 'Couldn’t reach OneSignal: ' + e.message }; }
}
function plainPlural_(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }

/* ───────────────────────── Account tracking (ScrapeCreators) ─────────────────────────
   Every night the script reads each saved TikTok account's recent posts (views, likes, comments, shares, saves)
   and follower count, so advocates don't have to log their filler posts. Posts that match a link logged for a
   campaign count as "Campaign"; everything else as "Filler". Costs about 2 ScrapeCreators credits per account per night. */

var SC_BASE = 'https://api.scrapecreators.com';
function scKey_() { return P_().getProperty('SCRAPE_KEY') || ''; }
function scRequest_(key, path, params) {
  var q = Object.keys(params).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
  return { url: SC_BASE + path + (q ? '?' + q : ''), method: 'get', headers: { 'x-api-key': key }, muteHttpExceptions: true };
}
/** {ok, data, error} from a ScrapeCreators response. */
function scParse_(res) {
  var code = res.getResponseCode(), j = null;
  try { j = JSON.parse(res.getContentText() || 'null'); } catch (e) {}
  if (code === 401 || code === 403) return { ok: false, error: 'ScrapeCreators didn’t accept the API key.' };
  if (code === 402) return { ok: false, error: 'Out of ScrapeCreators credits.' };
  if (code >= 200 && code < 300 && j && j.success !== false) return { ok: true, data: j };
  var msg = j && (j.message || j.error) ? String(j.message || j.error) : 'error ' + code;
  return { ok: false, error: msg.slice(0, 160) };
}
function scGet_(key, path, params) {
  try { return scParse_(UrlFetchApp.fetch(scRequest_(key, path, params).url, scRequest_(key, path, params))); }
  catch (e) { return { ok: false, error: 'Couldn’t reach ScrapeCreators: ' + e.message }; }
}
function num_(v) { var n = Number(v); return isFinite(n) && n >= 0 ? Math.round(n) : 0; }
/** One TikTok post from the profile-videos response, in our own shape. */
function scVideo_(it, account) {
  if (!it) return null;
  var id = String(it.aweme_id || it.id || it.group_id || '');
  if (!/^\d{6,}$/.test(id)) return null;
  var st = it.statistics || it.stats || {};
  var sec = Number(it.create_time || it.createTime || 0);
  var d = sec ? new Date(sec * 1000) : (it.create_time_utc ? new Date(it.create_time_utc) : null);
  return { videoId: id, account: account, url: 'https://www.tiktok.com/@' + account + '/video/' + id,
    postedOn: d && !isNaN(d) ? Utilities.formatDate(d, tz_(), 'yyyy-MM-dd') : '',
    views: num_(st.play_count != null ? st.play_count : st.playCount), likes: num_(st.digg_count != null ? st.digg_count : st.diggCount),
    comments: num_(st.comment_count != null ? st.comment_count : st.commentCount), shares: num_(st.share_count != null ? st.share_count : st.shareCount),
    saves: num_(st.collect_count != null ? st.collect_count : st.collectCount) };
}
/** The TikTok video id in a link: long links directly, short links (vm./vt./tiktok.com/t/) via their redirect. */
function videoIdFromLink_(link) {
  var m = /\/(?:video|photo)\/(\d{6,})/.exec(link || '') || /\/v\/(\d{6,})/.exec(link || '');
  return m ? m[1] : '';
}
function isShortLink_(link) { return /^https?:\/\/(vm|vt)\.tiktok\.com\//i.test(link || '') || /^https?:\/\/(www\.)?tiktok\.com\/t\//i.test(link || ''); }
function resolveShortLinks_(links) {
  var out = {};
  for (var i = 0; i < links.length; i += 20) {
    var chunk = links.slice(i, i + 20), res;
    var reqs = chunk.map(function (l) { return { url: l, followRedirects: false, muteHttpExceptions: true }; });
    try { res = UrlFetchApp.fetchAll(reqs); }
    catch (e) {   // one bad link can fail the whole batch: try them one by one
      res = reqs.map(function (q) { try { return UrlFetchApp.fetch(q.url, q); } catch (e2) { return null; } });
    }
    chunk.forEach(function (l, k) {
      if (!res[k]) return;
      var h = res[k].getHeaders() || {}, loc = h.Location || h.location || '';
      if (Array.isArray(loc)) loc = loc[0];
      var id = videoIdFromLink_(loc) || videoIdFromLink_(res[k].getContentText ? String(res[k].getContentText()).slice(0, 4000) : '');
      if (id) out[l] = id;
    });
  }
  return out;
}

/** Runs every night (see setupTracking). Also from the menu: "Update account stats now". */
function trackAccounts() {
  var key = scKey_();
  if (!key) return { ok: false, error: 'Account tracking isn’t set up.' };
  var started = Date.now(), today = today_(), errors = [], credits = '';
  var creators = read_('creators'), targets = [];
  creators.forEach(function (cr) { parseAccounts_(cr.accounts).forEach(function (a) { targets.push({ cr: cr, account: a }); }); });
  var existing = read_('videos'), seenAccount = {};
  existing.forEach(function (v) { seenAccount[lower_(v.account)] = true; });
  var fresh = {}, profiles = {}, backfill = addDays_(today, -40), done = 0;

  function take(t, list) {
    (list || []).forEach(function (it) { var v = scVideo_(it, t.account); if (v) { v.creatorId = t.cr.id; v.creator = t.cr.name; fresh[v.videoId] = v; } });
  }
  for (var i = 0; i < targets.length; i += 10) {
    if (Date.now() - started > 240000) { errors.push('Stopped early to stay within Google’s time limit: ' + (targets.length - i) + ' accounts are updated next night.'); break; }
    var batch = targets.slice(i, i + 10), reqs = [];
    batch.forEach(function (t) {
      reqs.push(scRequest_(key, '/v3/tiktok/profile/videos', { handle: t.account, sort_by: 'latest' }));
      reqs.push(scRequest_(key, '/v1/tiktok/profile', { handle: t.account }));
    });
    var res;
    try { res = UrlFetchApp.fetchAll(reqs); } catch (e) { errors.push('Couldn’t reach ScrapeCreators: ' + e.message); break; }
    batch.forEach(function (t, k) {
      var v = scParse_(res[2 * k]), p = scParse_(res[2 * k + 1]);
      if (!v.ok) { errors.push('@' + t.account + ': ' + v.error); return; }
      done++;
      if (v.data.credits_remaining != null) credits = v.data.credits_remaining;
      take(t, v.data.aweme_list);
      // First time we see an account: go back about 40 days so this month's count is complete
      if (!seenAccount[lower_(t.account)]) {
        var cur = v.data.max_cursor, pages = 0, list = v.data.aweme_list || [];
        while (cur && pages < 3 && list.length) {
          var oldest = list.map(function (it) { var x = scVideo_(it, t.account); return x ? x.postedOn : ''; }).filter(String).sort()[0] || '';
          if (!oldest || oldest < backfill) break;
          var more = scGet_(key, '/v3/tiktok/profile/videos', { handle: t.account, sort_by: 'latest', max_cursor: cur });
          if (!more.ok) break;
          list = more.data.aweme_list || []; take(t, list); cur = more.data.max_cursor; pages++;
        }
      }
      if (p.ok) {
        var st = (p.data && (p.data.stats || (p.data.userInfo && p.data.userInfo.stats))) || {};
        profiles[lower_(t.account)] = { t: t, followers: num_(st.followerCount), likesTotal: num_(st.heartCount != null ? st.heartCount : st.heart), videoCount: num_(st.videoCount) };
      }
    });
  }

  var nVideos = 0;
  withLock_(function () {
    // Link logged campaign posts to TikTok video ids (once per post)
    var posts = read_('posts'), short = [];
    posts.forEach(function (p) { if (!p.videoId) { var id = videoIdFromLink_(p.link); if (id) { p.videoId = id; update_('posts', p); } else if (isShortLink_(p.link)) short.push(p.link); } });
    if (short.length) {
      var ids = resolveShortLinks_(short.slice(0, 200));
      posts.forEach(function (p) { if (!p.videoId && ids[p.link]) { p.videoId = ids[p.link]; update_('posts', p); } });
    }
    var campaignOf = {};
    posts.forEach(function (p) { if (p.videoId) campaignOf[p.videoId] = p; });
    // Merge: refreshed numbers for videos we fetched, keep the rest, and (re)classify everything
    var rows = {}, order = [];
    existing.forEach(function (v) { rows[v.videoId] = v; order.push(v.videoId); });
    Object.keys(fresh).forEach(function (id) {
      if (!rows[id]) { rows[id] = {}; order.push(id); }
      rows[id] = merge_(merge_(rows[id], fresh[id]), { updated: today });
    });
    var all = order.map(function (id) {
      var v = rows[id], c = campaignOf[id];
      return merge_(v, { kind: c ? 'Campaign' : 'Filler', campaignId: c ? c.campaignId : '', campaign: c ? c.campaign : '' });
    }).sort(function (a, b) { return a.postedOn < b.postedOn ? 1 : a.postedOn > b.postedOn ? -1 : 0; });
    writeAll_('videos', all);
    nVideos = all.length;
    // One row per account per day
    var days = read_('accountDays'), have = {};
    days.forEach(function (d) { if (d.date === today) have[lower_(d.account)] = true; });
    appendMany_('accountDays', Object.keys(profiles).filter(function (a) { return !have[a]; }).map(function (a) {
      var x = profiles[a];
      return { date: today, creatorId: x.t.cr.id, account: x.t.account, followers: x.followers, likesTotal: x.likesTotal, videoCount: x.videoCount };
    }));
  });
  var summary = { at: stamp_(), accounts: targets.length, updated: done, videos: nVideos, credits: credits, errors: errors.slice(0, 15) };
  P_().setProperty('TRACK_LAST', JSON.stringify(summary));
  return summary;
}

/** Replaces all data rows of a tab in one go (used for the Videos tab, which is rewritten each night). */
function writeAll_(t, objs) {
  var sh = sheet_(t), n = TABS[t].cols.length, last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, n).clearContent();
  if (!objs.length) return;
  var r = sh.getRange(2, 1, objs.length, n);
  r.setNumberFormat('@');
  r.setValues(objs.map(function (o) { return toRow_(t, o); }));
}

function quotaOf_(cr) { var q = parseInt(cr.quota, 10); return q > 0 ? q : DEFAULT_QUOTA; }
function median_(arr) {
  if (!arr.length) return 0;
  var a = arr.slice().sort(function (x, y) { return x - y; }), m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
}
/** Summary numbers for one creator: this month vs quota, last 30 days performance. */
function creatorPerf_(cr, videos, today) {
  var mine = videos.filter(function (v) { return v.creatorId === cr.id; });
  var month = today.slice(0, 7), quota = quotaOf_(cr);
  var tm = mine.filter(function (v) { return v.postedOn.slice(0, 7) === month; });
  var day = +today.slice(8, 10), dim = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7), 0)).getUTCDate();
  var expected = Math.floor(quota * day / dim), count = tm.length;
  var since = addDays_(today, -30), l30 = mine.filter(function (v) { return v.postedOn >= since && v.postedOn <= today; });
  var views = l30.map(function (v) { return +v.views || 0; }), total = views.reduce(function (s, x) { return s + x; }, 0);
  var inter = l30.reduce(function (s, v) { return s + (+v.likes || 0) + (+v.comments || 0) + (+v.shares || 0); }, 0);
  return {
    month: { count: count, campaign: tm.filter(function (v) { return v.kind === 'Campaign'; }).length, quota: quota, expected: expected,
      status: count >= quota ? 'done' : count >= expected ? 'on' : 'behind' },
    last30: { posts: l30.length, views: total, median: median_(views), engagement: total ? Math.round(inter / total * 1000) / 10 : 0 },
    tracked: mine.length
  };
}
function trackingInfo_() {
  var last = null;
  try { last = JSON.parse(P_().getProperty('TRACK_LAST') || 'null'); } catch (e) {}
  return { on: !!scKey_(), last: last };
}

/** Charts and recent posts for one creator's page. */
function adminCreatorStats(key, creatorId) {
  requireAdmin_(key);
  var today = today_();
  var vids = read_('videos').filter(function (v) { return v.creatorId === creatorId; });
  var months = [];
  for (var k = 5; k >= 0; k--) {
    var d = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1 - k, 1));
    var m = d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2);
    var inM = vids.filter(function (v) { return v.postedOn.slice(0, 7) === m; });
    months.push({ month: m, campaign: inM.filter(function (v) { return v.kind === 'Campaign'; }).length,
      filler: inM.filter(function (v) { return v.kind !== 'Campaign'; }).length,
      views: inM.reduce(function (s, v) { return s + (+v.views || 0); }, 0) });
  }
  var since = addDays_(today, -120), byAcc = {};
  read_('accountDays').forEach(function (d) {
    if (d.creatorId !== creatorId || d.date < since) return;
    (byAcc[d.account] = byAcc[d.account] || []).push({ date: d.date, followers: +d.followers || 0, likesTotal: +d.likesTotal || 0, videoCount: +d.videoCount || 0 });
  });
  var accounts = Object.keys(byAcc).map(function (a) {
    var h = byAcc[a].sort(function (x, y) { return x.date < y.date ? -1 : 1; });
    return { account: a, history: h, latest: h[h.length - 1] };
  });
  var recent = vids.slice().sort(function (a, b) { return a.postedOn < b.postedOn ? 1 : a.postedOn > b.postedOn ? -1 : 0; }).slice(0, 40).map(function (v) {
    return { videoId: v.videoId, account: v.account, url: v.url, postedOn: v.postedOn, views: +v.views || 0, likes: +v.likes || 0,
      comments: +v.comments || 0, shares: +v.shares || 0, kind: v.kind || 'Filler', campaign: v.campaign };
  });
  return { months: months, accounts: accounts, recent: recent, tracking: trackingInfo_() };
}

/** Menu: paste the ScrapeCreators key once; turns on the nightly update and runs the first one. */
function setupTracking() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('Account tracking', 'Paste your ScrapeCreators API key.\n\n(ScrapeCreators dashboard → API key)', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var key = String(r.getResponseText() || '').trim();
  if (key.length < 10) { ui.alert('That key looks too short. Copy the whole key and try again.'); return; }
  var test = scGet_(key, '/v1/tiktok/profile', { handle: 'tiktok' });
  if (!test.ok) { ui.alert('That didn’t work: ' + test.error); return; }
  P_().setProperty('SCRAPE_KEY', key);
  setup();
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'trackAccounts') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('trackAccounts').timeBased().everyDays(1).atHour(4).create();
  var s = trackAccounts();
  ui.alert('Account tracking is on. It updates every night around 4–5am.\n\n' + trackSummary_(s));
}
function trackNow() { SpreadsheetApp.getUi().alert(trackSummary_(trackAccounts())); }
function trackSummary_(s) {
  if (!s || s.ok === false) return (s && s.error) || 'Nothing to report.';
  return 'Updated ' + s.updated + ' of ' + s.accounts + ' accounts · ' + s.videos + ' videos tracked' +
    (s.credits !== '' ? ' · ' + s.credits + ' ScrapeCreators credits left' : '') + (s.errors.length ? '\n\nProblems:\n' + s.errors.join('\n') : '');
}

/* ───────────────────────── Spreadsheet menu ───────────────────────── */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Advocates Portal')
    .addItem('Show links', 'showLinks')
    .addItem('Turn on email reminders…', 'turnOnReminders')
    .addItem('Turn off email reminders', 'turnOffReminders')
    .addItem('Set logins PIN…', 'setLoginsPin')
    .addItem('Set up phone notifications…', 'setupPush')
    .addItem('Set up account tracking…', 'setupTracking')
    .addItem('Update account stats now', 'trackNow')
    .addSeparator()
    .addItem('Import posts from another sheet…', 'importFromSheetPrompt')
    .addItem('Change app link…', 'resetAppUrl')
    .addItem('Set up tabs', 'setup')
    .addToUi();
}

/**
 * Daily 8–9am email to the team when someone's pay is due that day (plus anyone still unpaid).
 * Running this from the menu is also what gives the script permission to send emails.
 */
function turnOnReminders() {
  var ui = SpreadsheetApp.getUi(), props = P_();
  var me = '';
  try { me = Session.getEffectiveUser().getEmail(); } catch (e) {}
  var r = ui.prompt('Email reminders',
    'Which email should get pay-day reminders and login update requests?' + (me ? '\n\nLeave empty to use ' + me + '.' : ''),
    ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var to = String(r.getResponseText() || '').trim() || me;
  if (!isEmail_(to)) { ui.alert('That doesn’t look like an email address. Try again.'); return; }
  setup();
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'dailyReminders') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('dailyReminders').timeBased().everyDays(1).atHour(8).create();
  props.setProperty('NOTIFY_EMAIL', to);
  props.setProperty('REMINDERS_ON', '1');
  ui.alert('Reminders are on. ' + to + ' gets an email on the morning anyone’s pay is due, and when a creator asks to update a login.' +
    '\n\nCreators are also emailed when you add them to a campaign (if they have an email address).');
}

function turnOffReminders() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'dailyReminders') ScriptApp.deleteTrigger(t); });
  P_().deleteProperty('REMINDERS_ON');
  SpreadsheetApp.getUi().alert('Pay-day reminders are off.');
}

/** Runs every morning (see turnOnReminders). */
function dailyReminders() {
  var props = P_();
  var to = props.getProperty('NOTIFY_EMAIL');
  if (!props.getProperty('REMINDERS_ON') || !isEmail_(to)) return 0;
  var today = today_(), dueToday = [], late = [];
  read_('creators').forEach(function (cr) {
    var p = payInfo_(cr, today); if (!p || !p.due.length) return;
    if (p.due[p.due.length - 1] === today) dueToday.push({ cr: cr, p: p });
    else late.push({ cr: cr, p: p });
  });
  if (!dueToday.length) return 0;
  function line(x) {
    var extra = x.p.due.length > 1 ? ' (' + x.p.due.length + ' months unpaid, since ' + longDate_(x.p.due[0]) + ')' : '';
    return x.cr.name + extra;
  }
  var app = webAppUrl_(), adminKey = props.getProperty('ADMIN_KEY');
  var dash = app && !/^https:\/\/script\.google\.com\//.test(app) ? app + '?admin=' + adminKey : '';
  var body = 'Pay due today (' + longDate_(today) + '):\n' + dueToday.map(function (x) { return '• ' + line(x); }).join('\n') +
    (late.length ? '\n\nStill not marked as paid:\n' + late.map(function (x) { return '• ' + line(x) + ', due ' + longDate_(x.p.due[0]); }).join('\n') : '') +
    '\n\nOnce paid, click “Mark paid” in the Payments tab' + (dash ? ':\n' + dash : '.') + '\n';
  MailApp.sendEmail({ to: to, subject: 'Pay today: ' + dueToday.map(function (x) { return x.cr.name; }).join(', '), body: body, name: 'Stellar Advocates Portal' });
  return dueToday.length;
}

/** The PIN the team types in the dashboard to see account passwords. Only someone with access to this sheet can set it. */
function setLoginsPin() {
  var ui = SpreadsheetApp.getUi(), props = P_();
  var r = ui.prompt('Logins PIN', 'Choose a PIN (at least 4 characters). You’ll type it in the team dashboard to see account passwords.' +
    (props.getProperty('LOGINS_PIN_HASH') ? '\n\nThis replaces the current PIN.' : ''), ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  try { savePin_(r.getResponseText()); } catch (e) { ui.alert(e.message); return; }
  setup();
  ui.alert('PIN saved. Share it only with the people who should see account passwords.');
}

/** Paste the OneSignal App ID and App API key once. Running this also gives the script permission to contact OneSignal. */
function setupPush() {
  var ui = SpreadsheetApp.getUi(), props = P_();
  var r1 = ui.prompt('Phone notifications (1 of 2)', 'Paste your OneSignal App ID.\n\nIn OneSignal: Settings → Keys & IDs → OneSignal App ID.', ui.ButtonSet.OK_CANCEL);
  if (r1.getSelectedButton() !== ui.Button.OK) return;
  var appId = String(r1.getResponseText() || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(appId)) { ui.alert('That doesn’t look like an App ID (it looks like 1a2b3c4d-…). Try again.'); return; }
  var r2 = ui.prompt('Phone notifications (2 of 2)', 'Paste your OneSignal App API key.\n\nIn OneSignal: Settings → Keys & IDs → App API keys → Add key. Copy it straight away (it’s only shown once).', ui.ButtonSet.OK_CANCEL);
  if (r2.getSelectedButton() !== ui.Button.OK) return;
  var apiKey = String(r2.getResponseText() || '').trim().replace(/^(Key|Basic)\s+/i, '');
  if (apiKey.length < 20) { ui.alert('That key looks too short. Copy the whole key and try again.'); return; }
  // Check the key with OneSignal (this is also when Google asks for permission to contact it)
  // (a notification addressed to nobody: a good key gets "not subscribed", a bad one gets refused)
  var res = UrlFetchApp.fetch('https://api.onesignal.com/notifications?c=push', { method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Key ' + apiKey }, muteHttpExceptions: true,
    payload: JSON.stringify({ app_id: appId, target_channel: 'push', include_aliases: { external_id: ['adv_setup_check'] }, contents: { en: 'check' } }) });
  var code = res.getResponseCode(), text = String(res.getContentText() || '');
  if (code === 401 || code === 403) { ui.alert('OneSignal didn’t accept that key (error ' + code + '). Check you copied the App API key for this app, then try again.'); return; }
  if (code >= 400 && /app_id|app id|not found/i.test(text)) { ui.alert('OneSignal can’t find that App ID. Check it and try again.\n\n' + text.slice(0, 200)); return; }
  setup();
  props.setProperty('PUSH_APP_ID', appId);
  props.setProperty('PUSH_API_KEY', apiKey);
  ui.alert('Phone notifications are set up.\n\nCreators can now turn them on in their portal under My details. On iPhone they first need to add the portal to their home screen.');
}

function savePin_(pin) {
  pin = String(pin || '').trim();
  if (pin.length < 4) throw new Error('Use at least 4 characters.');
  var props = P_();
  var salt = newKey_();
  props.setProperty('LOGINS_PIN_SALT', salt);
  props.setProperty('LOGINS_PIN_HASH', hashPin_(pin, salt));
  props.deleteProperty('PIN_FAILS'); props.deleteProperty('PIN_LOCKED_UNTIL');
}

/** Run once. Creates the four tabs and the team key. Safe to run again. */
function setup() {
  Object.keys(TABS).forEach(function (t) { read_(t); });
  var props = P_();
  if (!props.getProperty('ADMIN_KEY')) props.setProperty('ADMIN_KEY', newKey_());
  props.setProperty('SHEET_ID', SpreadsheetApp.getActiveSpreadsheet().getId());
  var def = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && SpreadsheetApp.getActiveSpreadsheet().getSheets().length > 1) {
    SpreadsheetApp.getActiveSpreadsheet().deleteSheet(def);
  }
  return 'Tabs ready.';
}

function showLinks() {
  var ui = SpreadsheetApp.getUi();
  setup();
  var base = webAppUrl_();
  if (!base) {
    var r = ui.prompt('Paste your app link',
      'Paste the address of the Advocates Portal page (your GitHub Pages address, or the Web app URL ending in /exec):',
      ui.ButtonSet.OK_CANCEL);
    if (r.getSelectedButton() !== ui.Button.OK) return;
    try { base = cleanAppUrl_(r.getResponseText()); } catch (e) { ui.alert(e.message); return; }
    P_().setProperty('APP_LINK', base);
  }
  var adminKey = P_().getProperty('ADMIN_KEY');
  var rows = read_('creators').map(function (c) {
    return '<tr><td>' + esc_(c.name) + '</td><td><input readonly onclick="this.select()" value="' +
      esc_(base + '?creator=' + c.key) + '"></td></tr>';
  }).join('');
  var html = '<style>body{font:13px system-ui,sans-serif;color:#15161c}input{width:100%;font:12px monospace;padding:6px;border:1px solid #ccd;border-radius:6px}' +
    'td{padding:4px 6px;vertical-align:middle}h3{margin:14px 0 6px}p{color:#555}</style>' +
    '<h3>Team link (keep this internal)</h3><input readonly onclick="this.select()" value="' + esc_(base + '?admin=' + adminKey) + '">' +
    '<h3>Creator links</h3><p>Each creator only sees their own campaigns and posts. You can also copy these from the team view.</p>' +
    '<table style="width:100%">' + (rows || '<tr><td>No creators yet. Add them in the team view.</td></tr>') + '</table>';
  ui.showModalDialog(HtmlService.createHtmlOutput(html).setWidth(640).setHeight(460), 'Advocates Portal links');
}

function resetAppUrl() {
  P_().deleteProperty('APP_LINK');
  showLinks();
}

function importFromSheetPrompt() {
  var ui = SpreadsheetApp.getUi();
  var r1 = ui.prompt('Import posts', 'Paste the link of the sheet to import from (one tab per creator, with a "POST LINKS" column):', ui.ButtonSet.OK_CANCEL);
  if (r1.getSelectedButton() !== ui.Button.OK) return;
  var m = String(r1.getResponseText()).match(/\/d\/([a-zA-Z0-9_-]+)/);
  var sourceId = m ? m[1] : String(r1.getResponseText()).trim();
  var r2 = ui.prompt('Import posts', 'Which campaign should these posts go into? (Type a name; it is created if it does not exist.)', ui.ButtonSet.OK_CANCEL);
  if (r2.getSelectedButton() !== ui.Button.OK) return;
  setup();
  var res = importPosts(sourceId, String(r2.getResponseText()).trim() || 'Imported campaign');
  ui.alert('Imported ' + res.posts + ' posts from ' + res.creators.length + ' creators (' + res.creators.join(', ') + ').' +
    (res.duplicates ? ' Skipped ' + res.duplicates + ' links that were already in the portal.' : ''));
}

/**
 * Reads a planning sheet where each tab is one creator (e.g. ALYSSA, KI, PREET)
 * with DATE / ACC NAME / STATUS / POST LINKS / NOTES columns.
 */
function importPosts(sourceId, campaignName, sourceBook) {
  return withLock_(function () {
    var src = sourceBook || SpreadsheetApp.openById(sourceId);
    var tz = src.getSpreadsheetTimeZone ? src.getSpreadsheetTimeZone() : tz_();
    var skip = { CONFIG: 1, POOL: 1, CAMPAIGNS: 1, CREATORS: 1, MEMBERS: 1, POSTS: 1 };

    var campaign = find_('campaigns', function (c) { return lower_(c.name) === lower_(campaignName); });
    if (!campaign) {
      campaign = { id: newId_('c'), name: clean_(campaignName, 120), artist: '', sound: '', brief: '', status: 'Active', created: today_() };
      appendMany_('campaigns', [campaign]);
    }
    var creators = read_('creators');
    var members = read_('members');
    var seen = {};
    read_('posts').forEach(function (p) { seen[normLink_(p.link)] = true; });
    var newCreators = [], newMembers = [], newPosts = [], touched = [], duplicates = 0;
    var now = stamp_();

    src.getSheets().forEach(function (sh) {
      var tab = String(sh.getName()).trim();
      if (skip[tab.toUpperCase()]) return;
      var values = sh.getDataRange().getValues();
      var h = -1, col = {};
      for (var i = 0; i < Math.min(values.length, 15) && h < 0; i++) {
        var row = values[i].map(function (v) { return String(v).trim().toUpperCase(); });
        if (row.indexOf('POST LINKS') >= 0) {
          h = i;
          col = { date: row.indexOf('DATE'), account: row.indexOf('ACC NAME'), status: row.indexOf('STATUS'),
            link: row.indexOf('POST LINKS'), notes: row.indexOf('NOTES') };
        }
      }
      if (h < 0) return;
      var name = titleCase_(tab);
      var creator = null;
      creators.concat(newCreators).forEach(function (c) { if (lower_(c.name) === lower_(name)) creator = c; });
      var found = 0;
      for (var r = h + 1; r < values.length; r++) {
        var v = values[r];
        var links = String(v[col.link] || '').match(/https?:\/\/[^\s;,]+/gi) || [];
        var date = col.date >= 0 ? toIsoDate_(v[col.date], tz) : '';
        if (!links.length || !date) continue;
        if (!creator) {
          creator = { id: newId_('cr'), name: name, key: newKey_(), notes: '', created: today_() };
          newCreators.push(creator);
        }
        links.forEach(function (link) {
          var n = normLink_(link);
          if (seen[n]) { duplicates++; return; }
          seen[n] = true;
          found++;
          newPosts.push({ id: newId_('p'), submitted: now, creatorId: creator.id, creator: creator.name,
            campaignId: campaign.id, campaign: campaign.name,
            account: col.account >= 0 ? clean_(v[col.account], 60).replace(/^@+/, '') : '',
            link: link, postedOn: date,
            views: col.status >= 0 ? clean_(v[col.status], 40) : '',
            notes: col.notes >= 0 ? clean_(v[col.notes], 500) : '' });
        });
      }
      if (creator) {
        touched.push(creator.name);
        var has = members.concat(newMembers).some(function (m) { return m.campaignId === campaign.id && m.creatorId === creator.id; });
        if (!has) newMembers.push({ campaignId: campaign.id, creatorId: creator.id, added: today_() });
      }
    });
    appendMany_('creators', newCreators);
    appendMany_('members', newMembers);
    appendMany_('posts', newPosts);
    return { campaign: campaign.name, creators: touched, posts: newPosts.length, duplicates: duplicates };
  });
}

/* ───────────────────────── Access checks ───────────────────────── */

function requireAdmin_(key) {
  var real = P_().getProperty('ADMIN_KEY');
  if (!real || !key || String(key) !== real) throw new Error('This team link is not valid. Open Advocates Portal → Show links in the sheet to get the current one.');
}

function creatorByKey_(key) {
  key = String(key || '');
  var me = key.length >= 16 && find_('creators', function (c) { return c.key === key; });
  if (!me) throw new Error('This link is no longer active. Ask the Stellar team for your current link.');
  return me;
}

/* ───────────────────────── Sheet helpers ───────────────────────── */

/* Script properties, fetched once per request (each separate lookup is a round trip to Google). */
var P_CACHE_ = null;
function P_() {
  if (P_CACHE_) return P_CACHE_;
  var store = PropertiesService.getScriptProperties(), all = store.getProperties() || {};
  P_CACHE_ = {
    getProperty: function (k) { return Object.prototype.hasOwnProperty.call(all, k) ? all[k] : null; },
    setProperty: function (k, v) { store.setProperty(k, v); all[k] = String(v); return P_CACHE_; },
    deleteProperty: function (k) { store.deleteProperty(k); delete all[k]; return P_CACHE_; }
  };
  return P_CACHE_;
}

/* Opening the spreadsheet is slow, so each request opens it (and each tab) only once. */
var BOOK_ = null, SHEETS_ = {};
function book_() {
  if (BOOK_) return BOOK_;
  BOOK_ = SpreadsheetApp.getActiveSpreadsheet() || SpreadsheetApp.openById(P_().getProperty('SHEET_ID'));
  return BOOK_;
}

function sheet_(t) {
  if (SHEETS_[t]) return SHEETS_[t];
  var def = TABS[t], ss = book_();
  var sh = ss.getSheetByName(def.name);
  if (!sh) {
    sh = ss.insertSheet(def.name);
    sh.getRange(1, 1, 1, def.cols.length).setValues([def.cols.map(function (c) { return c[1]; })]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange(1, 1, sh.getMaxRows(), def.cols.length).setNumberFormat('@');
    HEADERS_OK_[t] = true;
  }
  SHEETS_[t] = sh;
  return sh;
}
/** Adds any missing column headers (e.g. columns added in an update). Uses the header row read_ already fetched. */
function ensureHeaders_(t, sh, head) {
  if (HEADERS_OK_[t]) return;
  TABS[t].cols.forEach(function (c, j) {
    if (!String((head && head[j]) || '').trim()) {
      sh.getRange(1, j + 1).setValues([[c[1]]]).setFontWeight('bold');
      sh.getRange(1, j + 1, sh.getMaxRows(), 1).setNumberFormat('@');
    }
  });
  HEADERS_OK_[t] = true;
}
var HEADERS_OK_ = {};

/** "@a, b\n@c" or ['a','@b'] → ['a','b','c'] (no @, no duplicates, max 20). */
function parseAccounts_(v) {
  var list = Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/);
  var out = [], seen = {};
  list.forEach(function (a) {
    a = String(a || '').trim().replace(/^@+/, '').slice(0, 60);
    if (a && !seen[a.toLowerCase()] && out.length < 20) { seen[a.toLowerCase()] = true; out.push(a); }
  });
  return out;
}

function read_(t) {
  var def = TABS[t], sh = sheet_(t);
  var values = sh.getDataRange().getValues();
  ensureHeaders_(t, sh, values[0]);
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i], o = { _row: i + 1 }, empty = true;
    def.cols.forEach(function (c, j) {
      var v = row[j];
      if (v instanceof Date) v = (c[0] === 'submitted') ? stamp_(v) : Utilities.formatDate(v, tz_(), 'yyyy-MM-dd');
      v = (v === null || v === undefined) ? '' : String(v);
      if (v !== '') empty = false;
      o[c[0]] = v;
    });
    if (!empty) out.push(o);
  }
  return out;
}

function find_(t, fn) {
  var rows = read_(t);
  for (var i = 0; i < rows.length; i++) if (fn(rows[i])) return rows[i];
  return null;
}

function toRow_(t, o) {
  return TABS[t].cols.map(function (c) { return safeCell_(o[c[0]]); });
}

function appendMany_(t, objs) {
  if (!objs.length) return;
  var sh = sheet_(t), n = TABS[t].cols.length;
  var start = sh.getLastRow() + 1;
  var range = sh.getRange(start, 1, objs.length, n);
  range.setNumberFormat('@');
  range.setValues(objs.map(function (o) { return toRow_(t, o); }));
}

function update_(t, o) {
  sheet_(t).getRange(o._row, 1, 1, TABS[t].cols.length).setValues([toRow_(t, o)]);
}

function deleteRow_(t, rowNum) { sheet_(t).deleteRow(rowNum); }

function deleteWhere_(t, fn) {
  var rows = read_(t).filter(fn).map(function (r) { return r._row; }).sort(function (a, b) { return b - a; });
  var sh = sheet_(t);
  rows.forEach(function (r) { sh.deleteRow(r); });
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ───────────────────────── Small utilities ───────────────────────── */

/** The app's address, pasted once from Deploy → Manage deployments → Web app URL.
    (Google's own ScriptApp.getService().getUrl() often returns an address that doesn't open.) */
function webAppUrl_() {
  return P_().getProperty('APP_LINK') || '';
}

/** Keeps the address exactly as Google shows it (Workspace addresses need their /a/macros/<domain>/ part);
    only drops anything after ? or #. */
function cleanAppUrl_(u) {
  u = String(u || '').trim().split('?')[0].split('#')[0];
  if (/^https:\/\/script\.google\.com\//.test(u)) {
    if (!/^https:\/\/script\.google\.com\/(a\/macros\/[^\/]+\/|macros\/)s\/[A-Za-z0-9_-]{20,}\/exec$/.test(u))
      throw new Error('That doesn’t look like the Web app URL. Copy it from Deploy → Manage deployments; it ends in /exec.');
    return u;
  }
  if (!/^https:\/\/[A-Za-z0-9.-]+\.[A-Za-z]{2,}(\/[^\s]*)?$/.test(u))
    throw new Error('That doesn’t look like a web address. Paste the page address, starting with https://');
  if (!/\/[^\/]*\.[A-Za-z0-9]+$/.test(u) && u.slice(-1) !== '/') u += '/';
  return u;
}

function adminSetAppUrl(key, url) {
  requireAdmin_(key);
  P_().setProperty('APP_LINK', cleanAppUrl_(url));
  return adminView(key);
}
function tz_() { return Session.getScriptTimeZone() || 'Etc/UTC'; }
function today_() { return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd'); }
function stamp_(d) { return Utilities.formatDate(d || new Date(), tz_(), 'yyyy-MM-dd HH:mm'); }
function newId_(prefix) { return prefix + '_' + Utilities.getUuid().replace(/-/g, '').slice(0, 10); }
function newKey_() { return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, 24); }
/** '' for blank, otherwise a whole number 0–100000 (or an error naming the field). */
function toCount_(v, label) {
  if (v === null || v === undefined || String(v).trim() === '') return '';
  var n = Number(String(v).trim());
  if (!isFinite(n) || n < 0 || Math.floor(n) !== n || n > 100000) throw new Error(label + ' must be a whole number.');
  return n;
}
function lower_(s) { return String(s || '').trim().toLowerCase(); }
function merge_(a, b) { var o = {}; for (var k in a) o[k] = a[k]; for (var j in b) o[j] = b[j]; return o; }
function clean_(s, max) { return String(s === null || s === undefined ? '' : s).trim().slice(0, max || 500); }
function isIsoDate_(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00Z').getTime()); }
function addDays_(iso, n) {
  var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function byPostedDesc_(a, b) {
  return (b.postedOn + b.submitted) < (a.postedOn + a.submitted) ? -1 : (b.postedOn + b.submitted) > (a.postedOn + a.submitted) ? 1 : 0;
}
function titleCase_(s) { return String(s).toLowerCase().replace(/(^|[\s\-'])\S/g, function (m) { return m.toUpperCase(); }); }
function esc_(s) {
  return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
}
/** Stops typed text from being run as a spreadsheet formula (and keeps a leading apostrophe, e.g. in a password). */
function safeCell_(v) {
  v = (v === null || v === undefined) ? '' : String(v);
  return /^[=+\-@']/.test(v) ? "'" + v : v;
}

/* ── sounds: one per line in the sheet, "Name | link", "link" or just a name ── */
function parseSounds_(v) {
  var out = [];
  String(v || '').split(/\r?\n/).forEach(function (s) {
    s = s.trim(); if (!s) return;
    var i = s.lastIndexOf(' | '), label = '', url = '';
    if (i >= 0) { label = s.slice(0, i).trim(); url = s.slice(i + 3).trim(); }
    else if (/^https?:\/\//i.test(s)) url = s;
    else label = s;
    if (url && !/^https?:\/\/\S+$/i.test(url)) { label = (label ? label + ' ' : '') + url; url = ''; }
    out.push({ label: label.slice(0, 80), url: url.slice(0, 500) });
  });
  return out.slice(0, 12);
}
/** From the campaign editor: [{label, url}] → cleaned list (or an error). */
function checkSounds_(list) {
  if (!Array.isArray(list)) list = parseSounds_(list);
  var out = [];
  list.forEach(function (s, i) {
    var label = clean_(s && s.label, 80).replace(/\s*\|\s*/g, ' / '), url = clean_(s && s.url, 500);
    if (!label && !url) return;
    if (url && !/^https?:\/\/\S+$/i.test(url)) throw new Error('Sound ' + (i + 1) + ': the link should start with https://');
    out.push({ label: label, url: url });
  });
  if (out.length > 12) throw new Error('Up to 12 sounds per campaign.');
  return out;
}
function soundsCell_(list) {
  return list.map(function (s) { return s.label && s.url ? s.label + ' | ' + s.url : (s.url || s.label); }).join('\n');
}

/* ── groups ("hyperpop, alt country") ── */
function parseTags_(v) {
  var out = [], seen = {};
  (Array.isArray(v) ? v : String(v || '').split(',')).forEach(function (t) {
    t = String(t || '').replace(/\s+/g, ' ').trim().replace(/^#/, '').slice(0, 30);
    if (t && !seen[t.toLowerCase()] && out.length < 12) { seen[t.toLowerCase()] = true; out.push(t); }
  });
  return out;
}

function isEmail_(s) { return /^[^\s@,;<>]+@[^\s@,;<>]+\.[A-Za-z]{2,}$/.test(String(s || '').trim()); }
var MONTHS_ = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function longDate_(iso) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? (+m[3]) + ' ' + MONTHS_[+m[2] - 1] + ' ' + m[1] : String(iso || ''); }

/* ── pay dates: every month on the same day as the pay date (the 31st becomes the last day in shorter months) ── */
function payOccurrence_(start, k) {
  var y = +start.slice(0, 4), m = +start.slice(5, 7) - 1 + k, d = +start.slice(8, 10);
  y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
  var dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return y + '-' + ('0' + (m + 1)).slice(-2) + '-' + ('0' + Math.min(d, dim)).slice(-2);
}
/** {day, next (oldest unpaid pay date), due (unpaid dates up to today), lastPaid, beforeLast} or null. */
function payInfo_(cr, today) {
  var start = cr.payStart;
  if (!isIsoDate_(start)) return null;
  var paid = isIsoDate_(cr.paidThrough) ? cr.paidThrough : '';
  var due = [], next = '', lastPaid = '', beforeLast = '';
  for (var k = 0; k < 1200; k++) {
    var o = payOccurrence_(start, k);
    if (paid && o <= paid) { beforeLast = lastPaid; lastPaid = o; continue; }
    if (!next) next = o;
    if (o <= today) { if (due.length < 36) due.push(o); continue; }
    break;
  }
  return { day: +start.slice(8, 10), start: start, next: next, due: due, lastPaid: lastPaid, beforeLast: beforeLast };
}

/* ── logins ── */
function currentLogins_(rows, creatorId) {
  return rows.filter(function (l) { return l.creatorId === creatorId && l.status !== LOGIN_STATUS.old; });
}
function loginKey_(status) {
  for (var k in LOGIN_STATUS) if (LOGIN_STATUS[k] === status) return k;
  return 'locked';
}
function hashPin_(pin, salt) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + String(pin).trim(), Utilities.Charset.UTF_8);
  return Utilities.base64Encode(bytes);
}
/** Wrong PIN 5 times in a row locks PIN checks for 15 minutes. */
function checkPin_(pin) {
  var props = P_();
  var hash = props.getProperty('LOGINS_PIN_HASH');
  if (!hash) throw new Error('No logins PIN yet. In the Google Sheet, open Advocates Portal → Set logins PIN.');
  var until = +(props.getProperty('PIN_LOCKED_UNTIL') || 0);
  if (until > Date.now()) throw new Error('Too many wrong PINs. Try again in ' + Math.ceil((until - Date.now()) / 60000) + ' minutes.');
  if (hashPin_(String(pin || ''), props.getProperty('LOGINS_PIN_SALT') || '') !== hash) {
    var fails = +(props.getProperty('PIN_FAILS') || 0) + 1;
    if (fails >= 5) { props.setProperty('PIN_LOCKED_UNTIL', String(Date.now() + 15 * 60000)); props.deleteProperty('PIN_FAILS'); }
    else props.setProperty('PIN_FAILS', String(fails));
    throw new Error('Wrong PIN.');
  }
  if (props.getProperty('PIN_FAILS')) props.deleteProperty('PIN_FAILS');
}

/** Email to the team address set in "Turn on email reminders" (does nothing if that's not set up). */
function notifyTeam_(subject, body) {
  var props = P_(), to = props.getProperty('NOTIFY_EMAIL');
  if (!props.getProperty('REMINDERS_ON') || !isEmail_(to)) return false;
  try { MailApp.sendEmail({ to: to, subject: subject, body: body, name: 'Stellar Advocates Portal' }); return true; } catch (e) { return false; }
}
/** Same link with or without trailing slash / tracking params counts as a duplicate. */
function normLink_(link) {
  var s = String(link || '').trim();
  if (/tiktok\.com|instagram\.com/i.test(s)) s = s.split('?')[0];
  return s.replace(/\/+$/, '').replace(/^http:/i, 'https:');
}
function toIsoDate_(v, tz) {
  if (v instanceof Date && !isNaN(v)) return Utilities.formatDate(v, tz || tz_(), 'yyyy-MM-dd');
  var s = String(v || '').trim();
  var m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return m[3] + '-' + ('0' + m[1]).slice(-2) + '-' + ('0' + m[2]).slice(-2);
  return isIsoDate_(s) ? s : '';
}

/** Functions the page is allowed to call (each checks its own key). */
var API_ = {
  creatorView: creatorView, submitPosts: submitPosts, deleteMyPost: deleteMyPost, updateMyPost: updateMyPost,
  adminView: adminView, adminSaveCampaign: adminSaveCampaign, adminDeleteCampaign: adminDeleteCampaign,
  adminSaveCreator: adminSaveCreator, adminResetLink: adminResetLink, adminDeleteCreator: adminDeleteCreator,
  adminSetAppUrl: adminSetAppUrl, adminSetMember: adminSetMember, adminUpdatePost: adminUpdatePost,
  adminDeletePost: adminDeletePost,
  creatorSaveLogin: creatorSaveLogin, creatorRequestUnlock: creatorRequestUnlock, creatorSaveEmail: creatorSaveEmail,
  adminSetPaid: adminSetPaid, adminSetLoginStatus: adminSetLoginStatus, adminLogins: adminLogins, adminSaveLogin: adminSaveLogin,
  creatorSetPush: creatorSetPush, adminTestPush: adminTestPush, adminCreatorStats: adminCreatorStats
};
