/* Iron Tiger Digital — shared lead-form submitter  v1  (2026-09-15)
 * Drop at  /js/form.js  on every site.  Include with:
 *     <script src="/js/form.js" defer></script>
 *
 * Progressive enhancement ONLY. If this file 404s or JS is off, the form is a
 * plain <form method="POST" action=".../ingest"> and the worker's _redirect
 * still lands the user on <page>#success. Nothing here is load-bearing.
 *
 * Contract with the worker (POST /ingest):
 *   200 {success:true, lead_id:"lead:…"}  -> real save        -> success state
 *   200 {success:true}   (no lead_id)     -> SILENTLY DROPPED -> failure state
 *   400 {error:"No contact info"}         -> failure state
 *   5xx / network error                   -> failure state
 * The no-lead_id case is why we cannot just check `res.ok`: the worker returns
 * 200 for spam-filtered and honeypot submissions. Requires the worker patch in
 * worker-ingest.patch (adds lead_id to the response). Until that ships, set
 * data-strict="false" on the form and only transport errors are caught.
 */
(function () {
  'use strict';

  var ENDPOINT = 'https://lead-manager-api.irontigerdigital.workers.dev/ingest';

  function $(root, sel) { return root.querySelector(sel); }

  function show(el) { if (el) el.style.display = 'block'; }
  function hide(el) { if (el) el.style.display = 'none'; }

  /* Build a tel:/mailto: escape hatch that carries everything the user typed,
   * so a failed submit never costs us the lead. */
  function fallbackHTML(form, data) {
    var tel = form.getAttribute('data-fallback-tel') || '';
    var mail = form.getAttribute('data-fallback-email') || '';
    var lines = [];
    ['name', 'phone', 'email', 'address', 'city', 'state', 'zip',
     'service', 'services', 'timeline', 'message', 'notes'].forEach(function (k) {
      var v = data[k];
      if (v) lines.push(k.charAt(0).toUpperCase() + k.slice(1) + ': ' + v);
    });
    var body = encodeURIComponent(lines.join('\n'));
    var subj = encodeURIComponent('Estimate request from ' + (data.name || 'website'));
    var html = '<strong>We could not send that.</strong><br>' +
               'Nothing you typed is lost — it is still in the form below. ';
    if (tel) {
      html += 'Fastest fix: <a href="tel:' + tel + '">call ' + tel + '</a>';
      if (mail) html += ' or ';
    }
    if (mail) {
      html += '<a href="mailto:' + mail + '?subject=' + subj + '&body=' + body +
              '">email us your details</a> (pre-filled)';
    }
    return html + '.';
  }

  /* Re-attach the estimate form's photo-count label, which lives on a listener
   * that a clone would otherwise drop. */
  function wirePhotoLabel(form) {
    var inp = form.querySelector('input[type="file"]');
    var lab = form.querySelector('#upload-label');
    if (!inp || !lab) return;
    inp.addEventListener('change', function () {
      var n = this.files.length;
      lab.textContent = n ? n + ' photo' + (n > 1 ? 's' : '') + ' selected'
                          : 'Tap to upload photos';
    });
  }

  function wire(form) {
    if (form.__itdWired) return;

    /* Some sites ship a legacy submit handler in js/main.js (Web3Forms, an
     * older /ingest fetch, or a Make.com hook). Two handlers on one form means
     * a double POST or a fake success. There is no removeEventListener for
     * someone else's closure, so replace the node with a clone, which carries
     * no listeners, then wire only ours. The patcher sets this attribute only
     * on the sites that actually have such a handler. */
    if (form.getAttribute('data-strip-legacy') === 'true') {
      var fresh = form.cloneNode(true);
      fresh.removeAttribute('data-strip-legacy');
      form.parentNode.replaceChild(fresh, form);
      form = fresh;
      wirePhotoLabel(form);
    }
    form.__itdWired = true;

    var okBox = document.getElementById(form.getAttribute('data-success') || 'form-success');
    var errBox = document.getElementById(form.getAttribute('data-error') || 'form-error');
    var strict = form.getAttribute('data-strict') !== 'false';

    /* Land on #success after the no-JS native-POST redirect path. */
    if (okBox && window.location.hash === '#success') { hide(form); show(okBox); }

    form.addEventListener('submit', function (e) {
      /* A checkbox group cannot use HTML `required` (it would demand that one
       * box), so enforce "at least one" here before native validation runs. */
      var groupName = form.getAttribute('data-require-one');
      if (groupName) {
        var boxes = form.querySelectorAll('input[name="' + groupName + '"]');
        var any = false;
        for (var b = 0; b < boxes.length; b++) if (boxes[b].checked) any = true;
        if (boxes.length) {
          boxes[0].setCustomValidity(any ? '' : 'Please choose at least one.');
          if (!any) { boxes[0].reportValidity(); e.preventDefault(); return; }
        }
      }
      /* Let the browser show its own messages for empty required fields. */
      if (form.checkValidity && !form.checkValidity()) return;
      e.preventDefault();

      var btn = form.querySelector('[type="submit"]');
      var label = btn ? btn.innerHTML : '';
      if (btn) { btn.disabled = true; btn.innerHTML = 'Sending…'; }
      hide(errBox);

      var fd = new FormData(form);
      var data = {};
      fd.forEach(function (v, k) {
        if (typeof v !== 'string') return;
        var bare = k.replace(/\[\]$/, '');
        data[bare] = data[bare] ? data[bare] + ', ' + v : v;
      });

      var failed = false;
      function fail() {
        if (failed) return; failed = true;
        if (btn) { btn.disabled = false; btn.innerHTML = label; }
        if (errBox) {
          errBox.innerHTML = fallbackHTML(form, data);
          show(errBox);
          errBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
          /* No error slot on this page: fall back to a native POST so the
           * browser's own navigation still reaches the worker. */
          form.__itdWired = false;
          HTMLFormElement.prototype.submit.call(form);
        }
      }

      var timer = setTimeout(fail, 15000);

      fetch(form.getAttribute('action') || ENDPOINT, {
        method: 'POST',
        body: fd,            /* multipart — carries file inputs too */
        headers: { 'Accept': 'application/json' }
      })
        .then(function (res) {
          return res.json().catch(function () { return {}; })
            .then(function (j) { return { ok: res.ok, j: j }; });
        })
        .then(function (r) {
          clearTimeout(timer);
          var saved = r.ok && r.j && r.j.success === true &&
                      (!strict || !!r.j.lead_id);
          if (!saved) return fail();
          if (btn) { btn.disabled = false; btn.innerHTML = label; }
          if (okBox) { hide(form); show(okBox); okBox.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
          try { form.reset(); } catch (_) {}
          if (window.gtag) window.gtag('event', 'generate_lead');
        })
        .catch(function () { clearTimeout(timer); fail(); });
    });
  }

  function init() {
    var forms = document.querySelectorAll('form[action*="/ingest"]');
    for (var i = 0; i < forms.length; i++) wire(forms[i]);
  }

  /* Run on `load`, not DOMContentLoaded: the legacy-handler strip above only
   * works if every other script has already attached. */
  if (document.readyState === 'complete') { init(); }
  else { window.addEventListener('load', init); }
})();
