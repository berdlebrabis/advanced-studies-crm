const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const dateFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const rows = document.querySelector('#contact-rows');
const searchInput = document.querySelector('#contact-search');
const dialog = document.querySelector('#contact-dialog');
const form = document.querySelector('#contact-form');
let contacts = [];
let householdOptions = [];
let householdOnly = false;
let selectedContactId = null;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function setScreen(screenName) {
  const knownScreens = ['dashboard', 'contacts', 'contact-details', 'memberships', 'donations', 'tasks', 'reports', 'settings'];
  const nextScreen = knownScreens.includes(screenName) ? screenName : 'dashboard';
  document.querySelectorAll('.screen').forEach((screen) => {
    screen.hidden = screen.id !== `screen-${nextScreen}`;
  });
  document.querySelectorAll('.nav-link').forEach((link) => {
    const active = link.dataset.screen === nextScreen;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  const section = document.querySelector(`#screen-${nextScreen}`);
  const title = section.dataset.title;
  document.querySelector('#current-page').textContent = title;
  document.title = `${title} · Advanced Studies CRM`;
  if (location.hash !== `#${nextScreen}`) history.replaceState(null, '', `#${nextScreen}`);
}

function renderContacts() {
  const search = searchInput.value.trim().toLocaleLowerCase();
  const matching = contacts.filter((contact) => {
    const words = `${contact.id} ${contact.name} ${contact.email} ${contact.phone}`.toLocaleLowerCase();
    return words.includes(search) && (!householdOnly || Boolean(contact.household_id));
  });
  document.querySelector('#showing-count').textContent = `Showing ${matching.length} of ${contacts.length} contacts`;
  document.querySelector('#clear-search').hidden = !search;
  document.querySelector('#filter-households').classList.toggle('active-filter', householdOnly);
  document.querySelector('#filter-households span').textContent = householdOnly ? 'Households only' : 'All contacts';
  if (!matching.length) {
    rows.innerHTML = '<tr><td colspan="5" class="empty">No contacts found. Try another search.</td></tr>';
    document.querySelector('#show-all').hidden = true;
    return;
  }
  rows.innerHTML = matching.map((contact) => `<tr>
    <td class="id-cell">${escapeHtml(contact.id)}</td>
    <td class="person-cell">${escapeHtml(contact.name)}</td>
    <td>${escapeHtml(contact.email || '—')}</td>
    <td>${escapeHtml(contact.household_name || '—')}</td>
    <td><button class="open-contact" type="button" data-open-contact="${escapeHtml(contact.id)}">Open</button></td>
  </tr>`).join('');
  document.querySelector('#show-all').hidden = true;
}

async function loadContacts() {
  const response = await fetch('/api/contacts');
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Could not load contacts.');
  contacts = result;
  renderContacts();
}

async function loadHouseholdOptions() {
  const response = await fetch('/api/households/options');
  householdOptions = await response.json();
  const select = document.querySelector('#contact-household');
  select.innerHTML = '<option value="">No household</option>' + householdOptions.map((household) =>
    `<option value="${escapeHtml(household.id)}">${escapeHtml(household.id)} · ${escapeHtml(household.name)}</option>`
  ).join('');
}

async function loadOverview() {
  const response = await fetch('/api/overview');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not load the dashboard.');
  document.querySelector('#test-date').textContent = `Class data date · ${dateFormat.format(new Date(`${data.testDate}T00:00:00`))}`;
  document.querySelector('#metric-contacts').textContent = data.activePeople;
  document.querySelector('#metric-members').textContent = data.activeMemberships;
  document.querySelector('#metric-giving').textContent = money.format(data.donationTotal);
  document.querySelector('#gift-count').textContent = `${data.donationCount} recorded gifts`;
  document.querySelector('#metric-renewals').textContent = data.renewalsDue;
  document.querySelector('#metric-tasks').textContent = data.overdueTasks;
}

async function openContact(contactId) {
  selectedContactId = contactId;
  const response = await fetch(`/api/contacts/${encodeURIComponent(contactId)}`);
  const contact = await response.json();
  if (!response.ok) {
    document.querySelector('#contact-detail-card').innerHTML = `<p class="empty">${escapeHtml(contact.error)}</p>`;
    setScreen('contact-details');
    return;
  }
  const details = [
    ['Contact ID', contact.id], ['Name', contact.name], ['Email', contact.email || '—'],
    ['Phone', contact.phone || '—'], ['Household', contact.household_name ? `${contact.household_id} · ${contact.household_name}` : '—'],
    ['Tags', contact.tags.length ? contact.tags.join(', ') : '—'], ['Notes', contact.notes || '—'],
    ['Email permission', contact.email_opt_in ? 'Granted' : 'Not granted']
  ];
  document.querySelector('#detail-subhead').textContent = `${contact.name} · ${contact.id}`;
  document.querySelector('#contact-detail-card').innerHTML = `
    <dl class="detail-grid">${details.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>
    <section class="linked-records"><h2>Linked records</h2><p>Memberships: ${contact.memberships.length ? contact.memberships.length : 'none saved yet'}</p><p>Donations: ${contact.donations.length ? contact.donations.length : 'none saved yet'}</p><p>Tasks: ${contact.tasks.length ? contact.tasks.length : 'none saved yet'}</p></section>`;
  setScreen('contact-details');
}

function openDialog() {
  form.reset();
  document.querySelector('#form-message').textContent = '';
  dialog.showModal();
  document.querySelector('#contact-id').focus();
}

function closeDialog() {
  dialog.close();
}

async function refreshData() {
  await Promise.all([loadContacts(), loadOverview()]);
}

function showError(error) {
  const message = document.querySelector('#contact-message');
  message.textContent = error.message;
  message.hidden = false;
}

document.querySelectorAll('.nav-link').forEach((link) => {
  link.addEventListener('click', () => setScreen(link.dataset.screen));
});
document.querySelectorAll('[data-screen-link]').forEach((button) => {
  button.addEventListener('click', () => setScreen(button.dataset.screenLink));
});
window.addEventListener('hashchange', () => setScreen(location.hash.slice(1)));
document.querySelectorAll('[data-add-contact]').forEach((button) => button.addEventListener('click', openDialog));
document.querySelector('#close-dialog').addEventListener('click', closeDialog);
document.querySelector('#cancel-contact').addEventListener('click', closeDialog);
document.querySelector('#clear-search').addEventListener('click', () => {
  searchInput.value = '';
  renderContacts();
  searchInput.focus();
});
document.querySelector('#filter-households').addEventListener('click', () => {
  householdOnly = !householdOnly;
  renderContacts();
});
searchInput.addEventListener('input', renderContacts);
rows.addEventListener('click', (event) => {
  const button = event.target.closest('[data-open-contact]');
  if (button) openContact(button.dataset.openContact).catch(showError);
});
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    setScreen('contacts');
    searchInput.focus();
  }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formMessage = document.querySelector('#form-message');
  formMessage.textContent = '';
  const data = Object.fromEntries(new FormData(form));
  data.email_opt_in = form.elements.email_opt_in.checked;
  try {
    const response = await fetch('/api/contacts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    });
    const result = await response.json();
    if (!response.ok) {
      formMessage.textContent = result.error || 'Could not save this contact.';
      if (result.error === 'Enter a name.') document.querySelector('#contact-name').focus();
      return;
    }
    closeDialog();
    setScreen('contacts');
    searchInput.value = '';
    await refreshData();
    const message = document.querySelector('#contact-message');
    message.textContent = `Contact ${result.id} saved.`;
    message.hidden = false;
    document.querySelector('#contacts').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    formMessage.textContent = error.message;
  }
});

setScreen(location.hash.slice(1) || 'dashboard');
Promise.all([loadHouseholdOptions(), refreshData()]).catch((error) => {
  document.querySelector('#contact-rows').innerHTML = `<tr><td colspan="5" class="empty">${escapeHtml(error.message)}</td></tr>`;
  document.querySelector('#contact-message').textContent = error.message;
  document.querySelector('#contact-message').hidden = false;
});
