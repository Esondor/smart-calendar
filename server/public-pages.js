// Public pages (no login) – needed for Google's OAuth branding verification: homepage + privacy policy.
import { serverConf } from './serverconf.js';

export const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><link rel="icon" href="/icon.svg"><style>
:root{color-scheme:light dark}body{margin:0;font:17px/1.55 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;background:Canvas;color:CanvasText;-webkit-font-smoothing:antialiased}
main{max-width:680px;margin:0 auto;padding:64px 24px}h1{font-size:40px;letter-spacing:-.03em;margin:16px 0 8px}h2{font-size:21px;margin:36px 0 6px}p,li{color:color-mix(in srgb,CanvasText 78%,transparent)}
.lead{font-size:21px}img{width:72px;height:72px;border-radius:16px}a{color:#007aff;text-decoration:none}.btn{display:inline-block;margin-top:22px;background:#007aff;color:#fff;padding:11px 22px;border-radius:12px;font-weight:600}
footer{margin-top:56px;font-size:14px;opacity:.6}</style></head><body><main>${body}</main></body></html>`;

export default async function publicPages(app) {
  app.get('/about', (req, reply) => {
    const c = serverConf();
    reply.type('text/html').send(page('Smart Calendar', `<img src="/icon.svg" alt=""><h1>Smart Calendar</h1>
      <p class="lead">A private planner that schedules tasks, household chores and projects into the free time of your calendar.</p>
      <h2>What it does</h2><ul><li>Reads your calendars to find free time.</li><li>Plans tasks and recurring chores into that time and writes the plan into a calendar of your choice.</li>
      <li>Notices when you move, complete or delete a planned block in your calendar and plans around it.</li><li>Lets a household share projects and chores.</li></ul>
      <h2>Google Calendar</h2><p>Smart Calendar uses the Google Calendar API only to read your events (to know when you are busy) and to create, update and delete the planning events it writes into the calendar you select. Nothing else is accessed.</p>
      <p>Smart Calendar is operated privately for invited members; there is no public sign-up.</p>
      <a class="btn" href="/">Sign In</a>
      <footer><a href="/privacy">Privacy Policy</a>${c.contact ? ` · <a href="mailto:${esc(c.contact)}">${esc(c.contact)}</a>` : ''}</footer>`));
  });
  app.get('/privacy', (req, reply) => {
    const c = serverConf(), host = esc(new URL(c.baseUrl || 'http://localhost').host);
    reply.type('text/html').send(page('Privacy Policy – Smart Calendar', `<h1>Privacy Policy</h1><p>Smart Calendar (${host}) is a privately operated planning application for invited users.</p>
      <h2>Data we access</h2><p>With your permission, Smart Calendar accesses your Google Calendar through the Google Calendar API (scope <code>calendar</code>): the list of your calendars, the time, title, description and free/busy status of events in the calendars you select, and the planning events it creates itself.</p>
      <h2>How we use it</h2><p>Calendar data is used only to calculate free time and to write your task plan into the calendar you chose. It is not used for advertising, profiling, or any other purpose, and it is not used to train machine-learning models.</p>
      <h2>Storage and sharing</h2><p>Data is stored on the operator’s own server. Access tokens are stored encrypted. Data is never sold or shared with third parties. Members of a project you share see the tasks of that project, not your calendar.</p>
      <h2>Retention and deletion</h2><p>Cached calendar events are refreshed continuously and removed when you disconnect the calendar. You can disconnect Google Calendar in Settings at any time, revoke access at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>, and ask the operator to delete your account and all associated data.</p>
      <h2>Google API Services User Data Policy</h2><p>Smart Calendar’s use of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>
      <h2>Contact</h2><p>${c.contact ? `<a href="mailto:${esc(c.contact)}">${esc(c.contact)}</a>` : 'The operator of this server.'}</p>
      <footer><a href="/about">Smart Calendar</a></footer>`));
  });
}
