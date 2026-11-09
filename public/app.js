const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const dateFormat = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });
const rows = document.querySelector('#contact-rows');
const searchInput = document.querySelector('#contact-search');
const dialog = document.querySelector('#contact-dialog');
const form = document.querySelector('#contact-form');
let contacts = [];
let householdOptions = [];
let allTags = [];
let currentUser = null;
let editingId = null;
let membershipPlans = [];
let memberships = [];
let practiceDate = '2026-10-15';
let selectedCsvFile = null;
let csvPreview = null;
let viewerExportAllowed = false;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options,
    headers: { ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const type = response.headers.get('content-type') || '';
  const result = type.includes('json') ? await response.json() : await response.text();
  if (!response.ok) {
    if (response.status === 401 && url !== '/api/auth/me' && url !== '/api/auth/login') showSignedOut();
    throw new Error(result.error || `Request failed (${response.status}).`);
  }
  return result;
}

function setScreen(screenName) {
  const knownScreens = ['dashboard', 'contacts', 'contact-details', 'memberships', 'donations', 'tasks', 'reports', 'settings'];
  const nextScreen = knownScreens.includes(screenName) ? screenName : 'dashboard';
  document.querySelectorAll('.screen').forEach((screen) => { screen.hidden = screen.id !== `screen-${nextScreen}`; });
  document.querySelectorAll('.nav-link').forEach((link) => {
    const active = link.dataset.screen === nextScreen;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });
  const section = document.querySelector(`#screen-${nextScreen}`);
  document.querySelector('#current-page').textContent = section.dataset.title;
  document.title = `${section.dataset.title} · Advanced Studies CRM`;
  if (location.hash !== `#${nextScreen}`) history.replaceState(null, '', `#${nextScreen}`);
  if (nextScreen === 'memberships' && currentUser) loadMembershipData().catch(showMembershipError);
  if (nextScreen === 'donations' && currentUser) loadDonations().catch((error) => showScreenError('#donation-message', error));
  if (nextScreen === 'tasks' && currentUser) loadTasks().catch((error) => showScreenError('#task-message', error));
  if (nextScreen === 'reports' && currentUser) loadReports().catch((error) => showScreenError('#report-message', error));
}

function roleCanWrite() { return currentUser && ['admin', 'staff'].includes(currentUser.role); }

function setSignedIn(user) {
  currentUser = user;
  document.querySelector('#auth-gate').hidden = true;
  document.querySelector('.shell').classList.remove('signed-out');
  document.querySelector('.shell').inert = false;
  document.querySelector('#signed-in-name').textContent = user.username;
  document.querySelector('#signed-in-role').textContent = `${user.role} access`;
  document.querySelector('#user-avatar').textContent = user.username.slice(0, 2).toUpperCase();
  document.querySelector('#role-chip').textContent = user.role;
  document.querySelector('#role-chip').hidden = false;
  document.querySelector('#sign-out').hidden = false;
  document.querySelectorAll('[data-add-contact]').forEach((button) => { button.hidden = !roleCanWrite(); });
  document.querySelector('#contact-import-tools').hidden = !roleCanWrite();
  document.querySelector('#contact-export-tools').hidden = !(user.role === 'admin' || (user.role === 'viewer' && viewerExportAllowed));
  document.querySelector('#user-management').hidden = user.role !== 'admin';
  document.querySelector('#add-membership').hidden = !roleCanWrite();
  document.querySelector('#membership-plan-editor').hidden = user.role !== 'admin';
  document.querySelector('#add-donation').hidden = !roleCanWrite();
  document.querySelector('#export-donations').hidden = user.role !== 'admin';
  document.querySelector('#add-task').hidden = !roleCanWrite();
  document.querySelector('#backup-tools').hidden = user.role !== 'admin';
  document.querySelector('#settings-summary').textContent = `Signed in as ${user.username} (${user.role}).`;
}

async function updateExportAccess() {
  const data = await api('/api/settings/export-permission');
  viewerExportAllowed = data.viewerExportAllowed;
  document.querySelector('#contact-export-tools').hidden = !(currentUser?.role === 'admin' || (currentUser?.role === 'viewer' && viewerExportAllowed));
}

function showSignedOut() {
  currentUser = null;
  document.querySelector('#auth-gate').hidden = false;
  document.querySelector('.shell').classList.add('signed-out');
  document.querySelector('.shell').inert = true;
  document.querySelector('#sign-out').hidden = true;
  document.querySelector('#role-chip').hidden = true;
  document.querySelector('#login-username').focus();
}

function currentContactFilters() {
  const params = new URLSearchParams();
  if (searchInput.value.trim()) params.set('search', searchInput.value.trim());
  if (document.querySelector('#tag-filter').value) params.set('tag', document.querySelector('#tag-filter').value);
  if (document.querySelector('#archived-filter').checked) params.set('archived', 'true');
  return params.toString();
}

function renderContacts() {
  const tag = document.querySelector('#tag-filter').value;
  document.querySelector('#showing-count').textContent = `Showing ${contacts.length} ${document.querySelector('#archived-filter').checked ? 'archived ' : ''}contact${contacts.length === 1 ? '' : 's'}`;
  document.querySelector('#clear-search').hidden = !searchInput.value.trim();
  if (!contacts.length) {
    rows.innerHTML = '<tr><td colspan="5" class="empty">No contacts found. Try another search or tag.</td></tr>';
    return;
  }
  rows.innerHTML = contacts.map((contact) => `<tr>
    <td class="id-cell">${escapeHtml(contact.id)}${contact.archived ? ' <span class="archived-badge">Archived</span>' : ''}</td>
    <td class="person-cell">${escapeHtml(contact.name)}</td>
    <td>${escapeHtml(contact.email || '—')}</td>
    <td>${contact.household_id ? `<button type="button" class="text-link" data-open-household="${escapeHtml(contact.household_id)}">${escapeHtml(contact.household_id)} · ${escapeHtml(contact.household_name || '')}</button>` : '—'}</td>
    <td><button class="open-contact" type="button" data-open-contact="${escapeHtml(contact.id)}">Open</button></td>
  </tr>`).join('');
  void tag;
}

async function loadContacts() {
  contacts = await api(`/api/contacts?${currentContactFilters()}`);
  renderContacts();
}

function updateTagOptions() {
  const select = document.querySelector('#tag-filter');
  const selected = select.value;
  select.innerHTML = '<option value="">All tags</option>' + allTags.map((tag) => `<option value="${escapeHtml(tag)}">${escapeHtml(tag)}</option>`).join('');
  if (allTags.includes(selected)) select.value = selected;
}

async function loadHouseholdOptions() {
  householdOptions = await api('/api/households/options');
  const select = document.querySelector('#contact-household');
  select.innerHTML = '<option value="">No household</option>' + householdOptions.map((household) =>
    `<option value="${escapeHtml(household.id)}">${escapeHtml(household.id)} · ${escapeHtml(household.name)}</option>`
  ).join('') + '<option value="__new__">Create a new household…</option>';
}

async function loadTags() { allTags = await api('/api/contact-tags'); updateTagOptions(); }

async function loadOverview() {
  const data = await api('/api/overview');
  practiceDate = data.testDate;
  document.querySelector('#test-date').textContent = `Practice data · ${dateFormat.format(new Date(`${data.testDate}T00:00:00`))}`;
  const dateInput = document.querySelector('#membership-as-of');
  if (!dateInput.dataset.initialized) { dateInput.value = data.testDate; dateInput.dataset.initialized = 'true'; }
  const reportDate = document.querySelector('#report-as-of');
  if (!reportDate.dataset.initialized) { reportDate.value = data.testDate; reportDate.dataset.initialized = 'true'; }
  document.querySelector('#metric-contacts').textContent = data.activePeople;
  document.querySelector('#metric-members').textContent = data.activeMemberships;
  document.querySelector('#metric-giving').textContent = money.format(data.donationTotal);
  document.querySelector('#gift-count').textContent = `${data.donationCount} recorded gifts`;
  document.querySelector('#metric-renewals').textContent = data.renewalsDue;
  document.querySelector('#metric-tasks').textContent = data.overdueTasks;
}

async function loadReports() {
  const date = document.querySelector('#report-as-of').value || practiceDate;
  const report = await api(`/api/reports?date=${encodeURIComponent(date)}`);
  document.querySelector('#report-donation-total').textContent = money.format(report.donations.total);
  document.querySelector('#report-donation-count').textContent = `${report.donations.count} saved, non-void gifts through ${report.asOf}`;
  document.querySelector('#report-active-memberships').textContent = report.activeMemberships;
  document.querySelector('#report-covered-people').textContent = report.peopleCovered;
  document.querySelector('#report-overdue-tasks').textContent = report.overdueTasks;
  document.querySelector('#report-campaign-rows').innerHTML = report.campaigns.map((item) => `<tr><td>${escapeHtml(item.campaign)}</td><td>${money.format(item.total)}</td></tr>`).join('') || '<tr><td colspan="2" class="empty">No donations saved by this date.</td></tr>';
}

function showMembershipError(error) {
  const message = document.querySelector('#membership-message');
  message.textContent = error.message;
  message.hidden = false;
}

function showScreenError(selector, error) { const node = document.querySelector(selector); node.textContent = error.message; node.hidden = false; }

function renderDonations(result) {
  const campaign = document.querySelector('#donation-campaign');
  const selected = campaign.value;
  campaign.innerHTML = '<option value="">All campaigns</option>' + result.campaigns.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
  campaign.value = result.campaigns.includes(selected) ? selected : '';
  document.querySelector('#donation-summary').textContent = `${money.format(result.summary.total)} from ${result.summary.count} non-void gifts`;
  const target = document.querySelector('#donation-rows');
  if (!result.donations.length) { target.innerHTML = '<tr><td colspan="8" class="empty">No gifts found for these filters.</td></tr>'; return; }
  target.innerHTML = result.donations.map((item) => `<tr class="${item.voided ? 'voided-row' : ''}"><td>${escapeHtml(item.id)}</td><td><button type="button" class="text-link" data-open-contact="${escapeHtml(item.contact_id)}">${escapeHtml(item.donor_name)}</button></td><td>${money.format(item.amount)}</td><td>${escapeHtml(item.date)}</td><td>${escapeHtml(item.campaign)}</td><td>${escapeHtml(item.method)} · ${escapeHtml(item.payment_code || '')}</td><td>${item.thank_you_sent ? 'Sent' : 'Needed'}${item.voided ? `<br>Voided by ${escapeHtml(item.voided_by || 'staff')} · ${escapeHtml(item.voided_at || '')}` : ''}</td><td>${!item.voided && roleCanWrite() ? `<button class="secondary-button void-donation" type="button" data-void-donation="${escapeHtml(item.id)}">Void</button>` : item.voided ? '<span class="membership-status status-ended">Void</span>' : '—'}<details class="membership-history"><summary>History (${item.history.length})</summary><ul>${item.history.map((change) => `<li>${escapeHtml(change.action)} · ${escapeHtml(change.actor_name)} · ${escapeHtml(dateFormat.format(new Date(change.occurred_at)))}</li>`).join('') || '<li>No change history.</li>'}</ul></details></td></tr>`).join('');
}

async function loadDonations() {
  const params = new URLSearchParams();
  const campaign = document.querySelector('#donation-campaign').value;
  const from = document.querySelector('#donation-from').value; const to = document.querySelector('#donation-to').value;
  if (campaign) params.set('campaign', campaign); if (from) params.set('from', from); if (to) params.set('to', to);
  renderDonations(await api(`/api/donations?${params}`));
}

document.querySelector('#export-donations').addEventListener('click', async () => {
  const params = new URLSearchParams();
  const campaign = document.querySelector('#donation-campaign').value;
  const from = document.querySelector('#donation-from').value; const to = document.querySelector('#donation-to').value;
  if (campaign) params.set('campaign', campaign); if (from) params.set('from', from); if (to) params.set('to', to);
  try {
    const response = await fetch(`/api/export/donations.csv?${params}`, { credentials: 'same-origin' });
    if (!response.ok) { const error = await response.json(); throw new Error(error.error || 'Export failed.'); }
    const disposition = response.headers.get('content-disposition') || '';
    const filename = disposition.match(/filename="?([^";]+)"?/)?.[1] || 'crm-donations.csv';
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url);
    document.querySelector('#donation-message').textContent = `${filename} downloaded.`;
  } catch (error) { document.querySelector('#donation-message').textContent = error.message; }
});

function renderTasks(result) {
  const count = result.counts;
  document.querySelector('#task-summary').textContent = `${count.total} manual tasks · ${count.complete} complete · ${count.open} open · ${count.overdue} overdue; ${result.allCounts.total - count.total} follow-up tasks total · as of ${result.asOf}`;
  const target = document.querySelector('#task-rows');
  if (!result.tasks.length) { target.innerHTML = '<tr><td colspan="8" class="empty">No tasks saved yet.</td></tr>'; return; }
  target.innerHTML = result.tasks.map((task) => `<tr class="${task.status === 'open' && task.due_date < result.asOf ? 'overdue-row' : ''}"><td>${escapeHtml(task.id)}</td><td><button type="button" class="text-link" data-open-contact="${escapeHtml(task.contact_id)}">${escapeHtml(task.contact_name)}</button></td><td>${escapeHtml(task.type)}</td><td>${escapeHtml(task.title)}<details class="membership-history"><summary>History (${task.history.length})</summary><ul>${task.history.map((change) => `<li>${escapeHtml(change.action)} · ${escapeHtml(change.actor_name)} · ${escapeHtml(dateFormat.format(new Date(change.occurred_at)))}</li>`).join('') || '<li>No change history.</li>'}</ul></details></td><td>${escapeHtml(task.owner)}</td><td>${escapeHtml(task.due_date || '—')}</td><td>${escapeHtml(task.status)}${task.status === 'open' && task.due_date < result.asOf ? ' · overdue' : ''}</td><td>${task.status === 'open' && roleCanWrite() ? `<button class="secondary-button complete-task" type="button" data-task-action="complete" data-task-id="${escapeHtml(task.id)}">Complete</button> <button class="secondary-button void-donation" type="button" data-task-action="cancel" data-task-id="${escapeHtml(task.id)}">Cancel</button>` : '—'}</td></tr>`).join('');
}

async function loadTasks() {
  const asOf = document.querySelector('#task-as-of').value || practiceDate;
  if (roleCanWrite()) await api('/api/tasks/ensure-followups', { method: 'POST', body: JSON.stringify({ date: asOf }) });
  renderTasks(await api(`/api/tasks?date=${encodeURIComponent(asOf)}`));
}

async function loadFormContacts(selectors) {
  const people = await api('/api/contacts?archived=false');
  for (const selector of selectors) {
    const select = document.querySelector(selector);
    select.innerHTML = '<option value="">Choose a contact</option>' + people.map((person) => `<option value="${escapeHtml(person.id)}">${escapeHtml(person.name)} · ${escapeHtml(person.id)}</option>`).join('');
  }
}

function membershipHistoryText(items) {
  if (!items.length) return 'No membership changes yet.';
  return items.map((item) => `${escapeHtml(item.action)} · ${escapeHtml(item.record_type)} ${escapeHtml(item.record_id)} · ${escapeHtml(item.actor_name)} · ${escapeHtml(dateFormat.format(new Date(item.occurred_at)))}`).join('<br>');
}

function renderMembershipSummary(summary) {
  document.querySelector('#membership-active-count').textContent = summary.active;
  document.querySelector('#membership-people-count').textContent = `people covered ${summary.peopleCovered}`;
  document.querySelector('#membership-ending-count').textContent = summary.endingSoon;
  document.querySelector('#membership-ended-count').textContent = summary.ended;
  document.querySelector('#membership-pending-count').textContent = summary.pending;
}

function renderMemberships() {
  const tbody = document.querySelector('#membership-rows');
  if (!memberships.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty">No membership records found.</td></tr>'; return; }
  tbody.innerHTML = memberships.map((item) => {
    const memberName = item.household_id ? `${item.household_name || item.household_id} · ${item.household_id}` : item.contact_name;
    const paidThrough = item.periods.length ? item.periods.reduce((latest, period) => period.end_date > latest ? period.end_date : latest, item.periods[0].end_date) : '—';
    const action = roleCanWrite() ? `<button class="secondary-button renew-membership" type="button" data-renew-membership="${escapeHtml(item.id)}">Renew</button>` : '';
    const history = `<details class="membership-history"><summary>Payments & history (${item.payments.length})</summary><ul>${item.payments.map((payment) => `<li>${escapeHtml(payment.payment_status || payment.status)} · ${money.format(payment.amount)} · ${escapeHtml(payment.payment_code)} · ${escapeHtml(payment.payment_date || 'date not recorded')}${payment.method ? ` · ${escapeHtml(payment.method)}` : ''}</li>`).join('') || '<li>No payments saved.</li>'}</ul><p><strong>Paid periods</strong></p><ul>${item.periods.map((period) => `<li>${escapeHtml(period.start_date)} to ${escapeHtml(period.end_date)} · ${money.format(period.amount)} · ${escapeHtml(period.payment_code)}</li>`).join('') || '<li>No paid period.</li>'}</ul><p><strong>Change history</strong><br>${membershipHistoryText(item.history)}</p></details>`;
    return `<tr><td>${escapeHtml(item.id)}</td><td><button type="button" class="text-link" data-open-contact="${escapeHtml(item.contact_id)}">${escapeHtml(memberName)}</button></td><td>${escapeHtml(membershipPlans.find((plan) => plan.id === item.plan)?.name || item.plan)}</td><td>${money.format(item.price)}</td><td><span class="membership-status status-${escapeHtml(item.status)}">${escapeHtml(item.status)}${item.status === 'active' && item.expiring ? ` · ${item.daysRemaining} days left` : ''}</span></td><td>${escapeHtml(paidThrough)}</td><td>${action}${history}</td></tr>`;
  }).join('');
}

function renderPlanPrices() {
  document.querySelector('#membership-plan-fields').innerHTML = membershipPlans.map((plan) => `<div class="plan-price-row"><label for="plan-price-${escapeHtml(plan.id)}">${escapeHtml(plan.name)} price</label><input id="plan-price-${escapeHtml(plan.id)}" type="number" min="0" step="0.01" value="${Number(plan.price).toFixed(2)}"><button type="button" class="secondary-button" data-save-plan="${escapeHtml(plan.id)}">Save price</button></div>`).join('');
}

async function loadMembershipData() {
  const asOf = document.querySelector('#membership-as-of').value || practiceDate;
  document.querySelector('#membership-message').textContent = '';
  const [summary, list, plans] = await Promise.all([
    api(`/api/memberships/summary?date=${encodeURIComponent(asOf)}`),
    api(`/api/memberships?date=${encodeURIComponent(asOf)}`),
    api('/api/membership-plans')
  ]);
  memberships = list;
  membershipPlans = plans;
  renderMembershipSummary(summary);
  renderMemberships();
  renderPlanPrices();
  const contactSelect = document.querySelector('#membership-contact');
  if (!contactSelect.options.length || contactSelect.options.length === 1) {
    const people = await api('/api/contacts?archived=false');
    contactSelect.innerHTML = '<option value="">Choose a person (or leave blank for a household)</option>' + people.map((person) => `<option value="${escapeHtml(person.id)}">${escapeHtml(person.name)} · ${escapeHtml(person.id)}</option>`).join('');
  }
  const householdSelect = document.querySelector('#membership-household');
  if (!householdSelect.options.length || householdSelect.options.length === 1) householdSelect.innerHTML = '<option value="">No household</option>' + householdOptions.map((household) => `<option value="${escapeHtml(household.id)}">${escapeHtml(household.name)} · ${escapeHtml(household.id)} (${household.people_count} people)</option>`).join('');
}

function openMembershipDialog() {
  const form = document.querySelector('#membership-form');
  form.reset();
  document.querySelector('#membership-form-message').textContent = '';
  document.querySelector('#membership-dialog-title').textContent = 'Add Membership';
  const planSelect = document.querySelector('#membership-plan');
  planSelect.innerHTML = membershipPlans.map((plan) => `<option value="${escapeHtml(plan.id)}">${escapeHtml(plan.name)} · ${money.format(plan.price)}</option>`).join('');
  document.querySelector('#membership-amount').value = membershipPlans[0]?.price ?? '';
  document.querySelector('#membership-payment-date').value = document.querySelector('#membership-as-of').value || practiceDate;
  document.querySelector('#membership-household').value = '';
  document.querySelector('#membership-contact').value = '';
  document.querySelector('#membership-dialog').showModal();
  planSelect.focus();
}

function openRenewDialog(membership) {
  const form = document.querySelector('#renew-form');
  form.reset();
  document.querySelector('#renew-form-message').textContent = '';
  document.querySelector('#renew-membership-id').value = membership.id;
  document.querySelector('#renew-dialog-title').textContent = `Renew ${membership.id}`;
  document.querySelector('#renew-price-note').textContent = `Saved renewal price: ${money.format(membership.price)}. Earlier paid years will remain in history.`;
  document.querySelector('#renew-amount').value = Number(membership.price).toFixed(2);
  document.querySelector('#renew-payment-date').value = document.querySelector('#membership-as-of').value || practiceDate;
  document.querySelector('#renew-dialog').showModal();
  document.querySelector('#renew-payment-code').focus();
}

function showHistory(history = []) {
  if (!history.length) return '<p class="empty">No history events recorded. Earlier saves from before this build were not tracked; changes now show the account and time.</p>';
  return `<ul class="history-list">${history.map((item) => `<li><strong>${escapeHtml(item.action)}</strong> · ${escapeHtml(item.record_type)} ${escapeHtml(item.record_id)} · ${escapeHtml(item.actor_name)} · ${escapeHtml(dateFormat.format(new Date(item.occurred_at)))}</li>`).join('')}</ul>`;
}

function showContactActions(contact) {
  const controls = roleCanWrite() ? `<div class="detail-actions"><button class="secondary-button" id="edit-contact" type="button" ${contact.archived ? 'disabled' : ''}>Edit</button>${contact.archived ? '<span class="archived-badge">Archived</span>' : `<button class="secondary-button archive-button" id="archive-contact" type="button">Archive</button>`}</div>` : '';
  return controls;
}

async function openContact(contactId) {
  const contact = await api(`/api/contacts/${encodeURIComponent(contactId)}`);
  const details = [
    ['Contact ID', contact.id], ['Name', contact.name], ['Email', contact.email || '—'],
    ['Phone', contact.phone || '—'], ['Household', contact.household_name ? `${contact.household_id} · ${contact.household_name}` : '—'],
    ['Tags', contact.tags.length ? contact.tags.join(', ') : '—'], ['Notes', contact.notes || '—'],
    ['Email permission', contact.email_opt_in ? 'Yes' : 'No'], ['Record status', contact.archived ? 'Archived' : 'Active']
  ];
  document.querySelector('#detail-subhead').textContent = `${contact.name} · ${contact.id}`;
  document.querySelector('#contact-detail-card').innerHTML = `${showContactActions(contact)}
    <dl class="detail-grid">${details.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>
    <section class="linked-records"><h2>Household people</h2><div id="detail-household-people">${contact.household_id ? 'Loading household…' : '<p>No household linked.</p>'}</div></section>
    <section class="linked-records"><h2>Linked records</h2>
      <h3>Memberships (${contact.memberships.length})</h3><ul class="record-history">${contact.memberships.map((item) => `<li>${escapeHtml(item.plan)} · ${money.format(item.price)} · ${escapeHtml(item.payment_status)} · ${escapeHtml(item.start_date || 'no start date')} to ${escapeHtml(item.end_date || 'no end date')}</li>`).join('') || '<li>None saved yet.</li>'}</ul>
      <h3>Donations (${contact.donations.length})</h3><ul class="record-history">${contact.donations.map((item) => `<li>${escapeHtml(item.id)} · ${money.format(item.amount)} · ${escapeHtml(item.date)} · ${escapeHtml(item.campaign)} · ${item.voided ? 'Void' : 'Saved'}</li>`).join('') || '<li>None saved yet.</li>'}</ul>
      <h3>Tasks (${contact.tasks.length})</h3><ul class="record-history">${contact.tasks.map((item) => `<li>${escapeHtml(item.id)} · ${escapeHtml(item.type)} · ${escapeHtml(item.title)} · due ${escapeHtml(item.due_date || 'no date')} · ${escapeHtml(item.status)}</li>`).join('') || '<li>None saved yet.</li>'}</ul></section>
    <section class="linked-records"><h2>Change history</h2>${showHistory(contact.history)}</section>`;
  if (contact.household_id) {
    try {
      const household = await api(`/api/households/${encodeURIComponent(contact.household_id)}`);
      document.querySelector('#detail-household-people').innerHTML = `<p>${escapeHtml(household.id)} · ${escapeHtml(household.name)}</p><ul class="household-people">${household.people.map((person) => `<li><button class="text-link" data-open-contact="${escapeHtml(person.id)}">${escapeHtml(person.name)} · ${escapeHtml(person.id)}</button>${person.archived ? ' (archived)' : ''} <span>${escapeHtml(person.email || 'no email')}</span></li>`).join('')}</ul>`;
    } catch (error) { document.querySelector('#detail-household-people').textContent = error.message; }
  }
  document.querySelector('#edit-contact')?.addEventListener('click', () => openDialog(contact));
  document.querySelector('#archive-contact')?.addEventListener('click', () => archiveContact(contact.id));
  setScreen('contact-details');
}

async function openHousehold(householdId) {
  const household = await api(`/api/households/${encodeURIComponent(householdId)}`);
  document.querySelector('#detail-subhead').textContent = `${household.name} · ${household.id}`;
  document.querySelector('#contact-detail-card').innerHTML = `<h2>${escapeHtml(household.name)}</h2><p class="subhead">Household ${escapeHtml(household.id)} · ${household.people.length} linked people</p><ul class="household-people">${household.people.map((person) => `<li><button class="text-link" data-open-contact="${escapeHtml(person.id)}">${escapeHtml(person.name)} · ${escapeHtml(person.id)}</button>${person.archived ? ' (archived)' : ''}<span>${escapeHtml(person.email || 'no email')} · ${escapeHtml(person.phone || 'no phone')}</span></li>`).join('')}</ul>`;
  setScreen('contact-details');
}

function openDialog(contact = null) {
  form.reset();
  editingId = contact?.id || null;
  document.querySelector('#form-message').textContent = '';
  document.querySelector('#contact-dialog-title').textContent = contact ? `Edit ${contact.name}` : 'Add Contact';
  document.querySelector('#contact-id').readOnly = Boolean(contact);
  document.querySelector('#contact-id').value = contact?.id || '';
  document.querySelector('#contact-name').value = contact?.name || '';
  document.querySelector('#contact-email').value = contact?.email || '';
  document.querySelector('#contact-phone').value = contact?.phone || '';
  document.querySelector('#contact-tags').value = contact?.tags?.join(', ') || '';
  document.querySelector('#contact-notes').value = contact?.notes || '';
  document.querySelector('#contact-email-opt-in').checked = Boolean(contact?.email_opt_in);
  document.querySelector('#contact-household').value = contact?.household_id || '';
  document.querySelector('#new-household-fields').hidden = true;
  document.querySelector('#new-household-id').value = '';
  document.querySelector('#new-household-name').value = '';
  dialog.showModal();
  (contact ? document.querySelector('#contact-name') : document.querySelector('#contact-id')).focus();
}

function closeDialog() { dialog.close(); }

async function refreshData() { await Promise.all([loadContacts(), loadOverview()]); }

function showError(error, target = '#contact-message') {
  const message = document.querySelector(target);
  message.textContent = error.message;
  message.hidden = false;
}

async function archiveContact(contactId) {
  if (!window.confirm(`Archive ${contactId}? Its history and links will be kept.`)) return;
  try {
    await api(`/api/contacts/${encodeURIComponent(contactId)}/archive`, { method: 'POST', body: '{}' });
    await refreshData();
    await openContact(contactId);
    document.querySelector('#contact-message').textContent = `${contactId} was archived. Its saved details remain available.`;
  } catch (error) { showError(error); }
}

async function loadSettings() {
  if (!currentUser) return;
  try {
    const audit = await api('/api/audit');
    document.querySelector('#audit-list').innerHTML = showHistory(audit);
    if (currentUser.role === 'admin') {
      const users = await api('/api/admin/users');
      const access = await api('/api/settings/export-permission');
      viewerExportAllowed = access.viewerExportAllowed;
      document.querySelector('#viewer-export-allowed').checked = viewerExportAllowed;
      document.querySelector('#user-list').innerHTML = `<table><thead><tr><th>USERNAME</th><th>ROLE</th><th>CHANGE ROLE</th></tr></thead><tbody>${users.map((user) => `<tr><td>${escapeHtml(user.username)}</td><td>${escapeHtml(user.role)}</td><td><select data-user-role="${user.id}" aria-label="Role for ${escapeHtml(user.username)}"><option ${user.role === 'viewer' ? 'selected' : ''} value="viewer">Viewer</option><option ${user.role === 'staff' ? 'selected' : ''} value="staff">Staff</option><option ${user.role === 'admin' ? 'selected' : ''} value="admin">Admin</option></select></td></tr>`).join('')}</tbody></table>`;
      document.querySelectorAll('[data-user-role]').forEach((select) => select.addEventListener('change', async () => {
        try { await api(`/api/admin/users/${select.dataset.userRole}`, { method: 'PATCH', body: JSON.stringify({ role: select.value }) }); }
        catch (error) { showError(error, '#user-message'); await loadSettings(); }
      }));
    }
  } catch (error) { showError(error, '#user-message'); }
}

document.querySelectorAll('.nav-link').forEach((link) => link.addEventListener('click', () => {
  setScreen(link.dataset.screen);
  if (link.dataset.screen === 'settings') loadSettings();
}));
document.querySelectorAll('[data-screen-link]').forEach((button) => button.addEventListener('click', () => setScreen(button.dataset.screenLink)));
window.addEventListener('hashchange', () => setScreen(location.hash.slice(1)));
document.querySelectorAll('[data-add-contact]').forEach((button) => button.addEventListener('click', () => openDialog()));
document.querySelector('#close-dialog').addEventListener('click', closeDialog);
document.querySelector('#cancel-contact').addEventListener('click', closeDialog);
document.querySelector('#contact-household').addEventListener('change', (event) => {
  const isNew = event.target.value === '__new__';
  document.querySelector('#new-household-fields').hidden = !isNew;
  document.querySelector('#new-household-id').required = isNew;
  document.querySelector('#new-household-name').required = isNew;
});
document.querySelector('#clear-search').addEventListener('click', () => { searchInput.value = ''; loadContacts().catch(showError); searchInput.focus(); });
searchInput.addEventListener('input', () => loadContacts().catch(showError));
document.querySelector('#tag-filter').addEventListener('change', () => loadContacts().catch(showError));
document.querySelector('#archived-filter').addEventListener('change', () => loadContacts().catch(showError));
rows.addEventListener('click', (event) => {
  const contactButton = event.target.closest('[data-open-contact]');
  const householdButton = event.target.closest('[data-open-household]');
  if (contactButton) openContact(contactButton.dataset.openContact).catch(showError);
  else if (householdButton) openHousehold(householdButton.dataset.openHousehold).catch(showError);
});
document.querySelector('#contact-detail-card').addEventListener('click', (event) => {
  const contactButton = event.target.closest('[data-open-contact]');
  if (contactButton) openContact(contactButton.dataset.openContact).catch(showError);
});
document.querySelector('#membership-rows').addEventListener('click', (event) => {
  const renewButton = event.target.closest('[data-renew-membership]');
  const contactButton = event.target.closest('[data-open-contact]');
  if (renewButton) {
    const membership = memberships.find((item) => item.id === renewButton.dataset.renewMembership);
    if (membership) openRenewDialog(membership);
  } else if (contactButton) openContact(contactButton.dataset.openContact).catch(showMembershipError);
});
document.querySelector('#donation-rows').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-void-donation]');
  const contactButton = event.target.closest('[data-open-contact]');
  if (contactButton) return openContact(contactButton.dataset.openContact).catch(showError);
  if (!button || !confirm(`Void donation ${button.dataset.voidDonation}? It will remain in history but leave totals.`)) return;
  try { const result = await api(`/api/donations/${encodeURIComponent(button.dataset.voidDonation)}/void`, { method: 'POST', body: '{}' }); document.querySelector('#donation-message').textContent = result.message; await loadDonations(); await refreshData(); }
  catch (error) { showScreenError('#donation-message', error); }
});
document.querySelector('#task-rows').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-task-action]');
  const contactButton = event.target.closest('[data-open-contact]');
  if (contactButton) return openContact(contactButton.dataset.openContact).catch(showError);
  if (!button) return;
  try { const result = await api(`/api/tasks/${encodeURIComponent(button.dataset.taskId)}/${button.dataset.taskAction}`, { method: 'POST', body: '{}' }); document.querySelector('#task-message').textContent = result.message; await loadTasks(); await refreshData(); }
  catch (error) { showScreenError('#task-message', error); }
});
document.querySelector('#filter-donations').addEventListener('click', () => loadDonations().catch((error) => showScreenError('#donation-message', error)));
document.querySelector('#donation-campaign').addEventListener('change', () => loadDonations().catch((error) => showScreenError('#donation-message', error)));
document.querySelector('#task-as-of').addEventListener('change', () => loadTasks().catch((error) => showScreenError('#task-message', error)));
document.querySelector('#add-donation').addEventListener('click', async () => {
  try { await loadFormContacts(['#donation-contact']); const form = document.querySelector('#donation-form'); form.reset(); document.querySelector('#donation-form-message').textContent = ''; document.querySelector('#donation-date').value = practiceDate; document.querySelector('#donation-dialog').showModal(); }
  catch (error) { showScreenError('#donation-message', error); }
});
document.querySelector('#close-donation-dialog').addEventListener('click', () => document.querySelector('#donation-dialog').close());
document.querySelector('#cancel-donation').addEventListener('click', () => document.querySelector('#donation-dialog').close());
document.querySelector('#donation-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; const message = document.querySelector('#donation-form-message'); message.textContent = '';
  const data = Object.fromEntries(new FormData(form)); data.thank_you_sent = form.elements.thank_you_sent.checked;
  try { const result = await api('/api/donations', { method: 'POST', body: JSON.stringify(data) }); document.querySelector('#donation-dialog').close(); form.reset(); document.querySelector('#donation-message').textContent = result.message; await loadDonations(); await refreshData(); }
  catch (error) { message.textContent = error.message; }
});
document.querySelector('#add-task').addEventListener('click', async () => {
  try { await loadFormContacts(['#task-contact']); const form = document.querySelector('#task-form'); form.reset(); document.querySelector('#task-form-message').textContent = ''; document.querySelector('#task-owner').value = currentUser.username; document.querySelector('#task-due-date').value = document.querySelector('#task-as-of').value || practiceDate; document.querySelector('#task-dialog').showModal(); }
  catch (error) { showScreenError('#task-message', error); }
});
document.querySelector('#close-task-dialog').addEventListener('click', () => document.querySelector('#task-dialog').close());
document.querySelector('#cancel-task').addEventListener('click', () => document.querySelector('#task-dialog').close());
document.querySelector('#task-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; const message = document.querySelector('#task-form-message'); message.textContent = '';
  try { const result = await api('/api/tasks', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) }); document.querySelector('#task-dialog').close(); form.reset(); document.querySelector('#task-message').textContent = result.message; await loadTasks(); await refreshData(); }
  catch (error) { message.textContent = error.message; }
});
document.querySelector('#download-backup').addEventListener('click', async () => {
  const message = document.querySelector('#backup-message'); message.textContent = '';
  try { const response = await fetch('/api/admin/backup', { credentials: 'same-origin' }); if (!response.ok) throw new Error((await response.json()).error || 'Backup failed.'); const url = URL.createObjectURL(await response.blob()); const link = document.createElement('a'); link.href = url; link.download = 'crm-backup.json'; link.click(); URL.revokeObjectURL(url); message.textContent = 'Backup downloaded.'; }
  catch (error) { message.textContent = error.message; }
});
document.querySelector('#restore-backup-file').addEventListener('change', async (event) => {
  const file = event.target.files[0]; if (!file) return;
  const message = document.querySelector('#backup-message'); message.textContent = '';
  try { const backup = JSON.parse(await file.text()); const result = await api('/api/admin/restore', { method: 'POST', body: JSON.stringify(backup) }); message.textContent = `${result.message} Copy: ${result.file}`; }
  catch (error) { message.textContent = error.message; }
  finally { event.target.value = ''; }
});
document.querySelector('#membership-as-of').addEventListener('change', () => loadMembershipData().catch(showMembershipError));
document.querySelector('#add-membership').addEventListener('click', () => loadMembershipData().then(openMembershipDialog).catch(showMembershipError));
document.querySelector('#membership-plan').addEventListener('change', (event) => {
  const plan = membershipPlans.find((item) => item.id === event.target.value);
  if (plan) document.querySelector('#membership-amount').value = Number(plan.price).toFixed(2);
});
document.querySelector('#close-membership-dialog').addEventListener('click', () => document.querySelector('#membership-dialog').close());
document.querySelector('#cancel-membership').addEventListener('click', () => document.querySelector('#membership-dialog').close());
document.querySelector('#membership-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = document.querySelector('#membership-form-message');
  message.textContent = '';
  const data = Object.fromEntries(new FormData(event.currentTarget));
  try {
    const result = await api('/api/memberships', { method: 'POST', body: JSON.stringify(data) });
    document.querySelector('#membership-dialog').close();
    event.currentTarget.reset();
    document.querySelector('#membership-message').textContent = result.status === 'paid'
      ? `${result.id} saved with coverage through ${result.end_date}.`
      : `${result.id} saved as ${result.status}; no membership time was added.`;
    await Promise.all([loadMembershipData(), loadOverview()]);
  } catch (error) { message.textContent = error.message; }
});
document.querySelector('#close-renew-dialog').addEventListener('click', () => document.querySelector('#renew-dialog').close());
document.querySelector('#cancel-renew').addEventListener('click', () => document.querySelector('#renew-dialog').close());
document.querySelector('#renew-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = document.querySelector('#renew-form-message');
  message.textContent = '';
  const data = Object.fromEntries(new FormData(event.currentTarget));
  try {
    const result = await api(`/api/memberships/${encodeURIComponent(data.id)}/renew`, { method: 'POST', body: JSON.stringify(data) });
    document.querySelector('#renew-dialog').close();
    event.currentTarget.reset();
    document.querySelector('#membership-message').textContent = result.payment_status === 'paid'
      ? `${result.id} renewed from ${result.start_date} through ${result.end_date}.`
      : `${result.id} payment recorded as ${result.payment_status}; no time was added.`;
    await Promise.all([loadMembershipData(), loadOverview()]);
  } catch (error) { message.textContent = error.message; }
});
document.querySelector('#membership-plan-fields').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-save-plan]');
  if (!button) return;
  const planId = button.dataset.savePlan;
  const price = Number(document.querySelector(`#plan-price-${CSS.escape(planId)}`).value);
  try {
    const plan = await api(`/api/admin/membership-plans/${encodeURIComponent(planId)}`, { method: 'PATCH', body: JSON.stringify({ price }) });
    document.querySelector('#membership-message').textContent = `${plan.name} now costs ${money.format(plan.price)} for new memberships. Existing memberships keep their saved prices.`;
    await loadMembershipData();
  } catch (error) { showMembershipError(error); }
});
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && currentUser) { event.preventDefault(); setScreen('contacts'); searchInput.focus(); }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formMessage = document.querySelector('#form-message');
  formMessage.textContent = '';
  const data = Object.fromEntries(new FormData(form));
  data.email_opt_in = form.elements.email_opt_in.checked;
  if (data.household_id === '__new__') {
    if (!data.new_household_id.trim() || !data.household_name.trim()) {
      formMessage.textContent = 'Enter a new household ID and name, or choose an existing household.';
      document.querySelector(data.new_household_id.trim() ? '#new-household-name' : '#new-household-id').focus();
      return;
    }
    data.household_id = data.new_household_id;
  }
  delete data.new_household_id;
  if (!data.household_id) data.household_name = '';
  try {
    const url = editingId ? `/api/contacts/${encodeURIComponent(editingId)}` : '/api/contacts';
    const result = await api(url, { method: editingId ? 'PUT' : 'POST', body: JSON.stringify(data) });
    closeDialog();
    setScreen('contacts');
    searchInput.value = '';
    await loadHouseholdOptions();
    await refreshData();
    document.querySelector('#contact-message').textContent = `Contact ${result.id} ${editingId ? 'updated' : 'saved'}.`;
    document.querySelector('#contact-message').hidden = false;
    if (editingId) await openContact(result.id);
  } catch (error) {
    formMessage.textContent = error.message;
    if (error.message.toLowerCase().includes('name')) document.querySelector('#contact-name').focus();
  }
});

document.querySelector('#load-practice-data').addEventListener('click', async () => {
  const button = document.querySelector('#load-practice-data');
  button.disabled = true;
  try {
    const result = await api('/api/import/practice-data', { method: 'POST', body: '{}' });
    document.querySelector('#contact-message').textContent = result.message;
    await loadHouseholdOptions();
    await refreshData();
  } catch (error) { showError(error); } finally { button.disabled = false; }
});

document.querySelector('#csv-import-file').addEventListener('change', (event) => {
  selectedCsvFile = event.target.files[0] || null; csvPreview = null;
  document.querySelector('#csv-file-name').textContent = selectedCsvFile?.name || 'No file chosen';
  document.querySelector('#preview-csv').disabled = !selectedCsvFile;
  document.querySelector('#csv-preview-panel').hidden = true;
});

function renderCsvPreview(result) {
  csvPreview = result;
  document.querySelector('#csv-preview-summary').textContent = `${result.added} new · ${result.duplicates} duplicate · ${result.errors} error`;
  document.querySelector('#csv-preview-rows').innerHTML = result.rows.map((item) => `<tr><td>${item.row}</td><td>${escapeHtml(item.id || '—')}</td><td>${escapeHtml(item.contact?.name || '')}</td><td><span class="csv-status csv-${item.status.toLowerCase()}">${escapeHtml(item.status)}</span></td><td>${escapeHtml(item.message)}</td></tr>`).join('');
  document.querySelector('#csv-preview-message').textContent = result.errors ? 'Fix every Error before importing. No rows will be saved while errors remain.' : 'Preview is ready. Import saves all New rows together; Duplicate rows stay unchanged.';
  document.querySelector('#import-csv').disabled = result.errors > 0;
  document.querySelector('#csv-preview-panel').hidden = false;
}

document.querySelector('#preview-csv').addEventListener('click', async () => {
  if (!selectedCsvFile) return;
  try { renderCsvPreview(await api('/api/import/contacts-csv/preview', { method: 'POST', body: JSON.stringify({ csv: await selectedCsvFile.text(), filename: selectedCsvFile.name }) })); }
  catch (error) { showError(error); }
});

document.querySelector('#import-csv').addEventListener('click', async () => {
  if (!selectedCsvFile || !csvPreview || csvPreview.errors) return;
  const button = document.querySelector('#import-csv'); button.disabled = true;
  try {
    const result = await api('/api/import/contacts-csv', { method: 'POST', body: JSON.stringify({ csv: await selectedCsvFile.text(), filename: selectedCsvFile.name }) });
    renderCsvPreview(result);
    document.querySelector('#csv-preview-message').textContent = result.message;
    document.querySelector('#csv-file-name').textContent = `${selectedCsvFile.name} · imported`;
    await Promise.all([loadHouseholdOptions(), refreshData()]);
  } catch (error) { document.querySelector('#csv-preview-message').textContent = error.message; button.disabled = !csvPreview || csvPreview.errors > 0; }
});

document.querySelector('#cancel-csv-import').addEventListener('click', () => {
  selectedCsvFile = null; csvPreview = null; document.querySelector('#csv-import-file').value = '';
  document.querySelector('#csv-file-name').textContent = 'No file chosen'; document.querySelector('#preview-csv').disabled = true;
  document.querySelector('#csv-preview-panel').hidden = true; document.querySelector('#csv-preview-message').textContent = '';
});

async function downloadContactFile(endpoint, filename) {
  try {
    const filters = currentContactFilters(); const url = `${endpoint}${filters ? `?${filters}` : ''}`;
    const response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok) { const error = await response.json(); throw new Error(error.error || 'Export failed.'); }
    const urlObject = URL.createObjectURL(await response.blob());
    const link = document.createElement('a'); link.href = urlObject; link.download = filename; link.click(); URL.revokeObjectURL(urlObject);
    document.querySelector('#contact-message').textContent = `${filename} downloaded.`;
  } catch (error) { showError(error); }
}
document.querySelector('#export-contacts').addEventListener('click', () => downloadContactFile('/api/export/contacts.csv', 'crm-contacts.csv'));
document.querySelector('#export-email-list').addEventListener('click', () => downloadContactFile('/api/export/email-list.csv', 'crm-email-list.csv'));
document.querySelector('#report-as-of').addEventListener('change', () => loadReports().catch((error) => showScreenError('#report-message', error)));
document.querySelector('#viewer-export-allowed').addEventListener('change', async (event) => {
  const checkbox = event.currentTarget;
  try { const result = await api('/api/admin/settings/viewer-export', { method: 'PATCH', body: JSON.stringify({ allowed: checkbox.checked }) }); viewerExportAllowed = result.viewerExportAllowed; document.querySelector('#export-setting-message').textContent = viewerExportAllowed ? 'Viewer exports are enabled.' : 'Viewer exports are disabled.'; }
  catch (error) { checkbox.checked = !checkbox.checked; document.querySelector('#export-setting-message').textContent = error.message; }
});

document.querySelector('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = Object.fromEntries(new FormData(event.currentTarget));
  try {
    const { user } = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(formData) });
    setSignedIn(user);
    document.querySelector('#login-message').textContent = '';
    await Promise.all([loadHouseholdOptions(), loadTags(), updateExportAccess()]);
    await refreshData();
    if (location.hash === '#memberships') await loadMembershipData();
    if (location.hash === '#donations') await loadDonations();
    if (location.hash === '#tasks') await loadTasks();
    if (location.hash === '#reports') await loadReports();
    if (user.role === 'admin' && location.hash === '#settings') loadSettings();
    document.querySelector('#contact-search').focus();
  } catch (error) { showError(error, '#login-message'); }
});

document.querySelector('#sign-out').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); } finally { showSignedOut(); }
});

document.querySelector('#new-user-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  try {
    await api('/api/admin/users', { method: 'POST', body: JSON.stringify(data) });
    event.currentTarget.reset();
    document.querySelector('#user-message').textContent = 'User added.';
    await loadSettings();
  } catch (error) { showError(error, '#user-message'); }
});

async function boot() {
  setScreen(location.hash.slice(1) || 'dashboard');
  try {
    const { user } = await api('/api/auth/me');
    setSignedIn(user);
    await Promise.all([loadHouseholdOptions(), loadTags(), updateExportAccess()]);
    await refreshData();
    if (location.hash === '#memberships') await loadMembershipData();
    if (location.hash === '#settings') loadSettings();
    if (location.hash === '#reports') await loadReports();
  } catch (_error) { showSignedOut(); }
}
boot();
