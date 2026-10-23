const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const dateFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const rows = document.querySelector('#contact-rows');
const searchInput = document.querySelector('#contact-search');
const dialog = document.querySelector('#contact-dialog');
const form = document.querySelector('#contact-form');
let allContacts = [];
let showAll = false;
let householdOnly = false;
let searchTimer;

function initials(name) {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase();
}

function renderContacts() {
  const query = searchInput.value.trim().toLowerCase();
  const visible = allContacts.filter((person) => {
    const matchesSearch = `${person.name} ${person.email} ${person.phone} ${person.id}`.toLowerCase().includes(query);
    return matchesSearch && (!householdOnly || person.household_name);
  });
  const displayed = showAll || query || householdOnly ? visible : visible.slice(0, 7);
  document.querySelector('#showing-count').textContent = `Showing ${displayed.length} of ${visible.length} people`;
  document.querySelector('#nav-contact-count').textContent = allContacts.length;
  document.querySelector('#view-all').innerHTML = showAll ? 'Show less <span>↗</span>' : 'View all <span>↗</span>';
  if (!displayed.length) {
    rows.innerHTML = '<tr><td colspan="5" class="empty">No people match this search.</td></tr>';
    return;
  }
  rows.innerHTML = displayed.map((person, index) => {
    const type = person.tags.includes('member') ? 'Member' : 'Supporter';
    const tagClass = type === 'Supporter' ? 'tag donor' : 'tag';
    const household = person.household_name || '—';
    const giving = Number(person.giving_total) ? money.format(person.giving_total) : '—';
    return `<tr>
      <td class="person-cell"><div class="person-info"><span class="person-avatar tone-${index % 4}">${initials(person.name)}</span><span class="person-meta">${person.name}<small>${person.email || person.id}</small></span></div></td>
      <td class="household">${household}</td><td class="giving-amount">${giving}</td><td><span class="${tagClass}">${type}</span></td><td class="row-menu">···</td>
    </tr>`;
  }).join('');
}

async function loadContacts() {
  const response = await fetch('/api/contacts');
  if (!response.ok) throw new Error('Could not load people.');
  allContacts = await response.json();
  renderContacts();
}

async function loadOverview() {
  const response = await fetch('/api/overview');
  if (!response.ok) throw new Error('Could not load the overview.');
  const data = await response.json();
  document.querySelector('#test-date').textContent = `Demo date · ${dateFormat.format(new Date(`${data.testDate}T00:00:00`))}, ${data.testDate.slice(0, 4)}`;
  document.querySelector('#metric-contacts').textContent = data.contactCount;
  document.querySelector('#metric-members').textContent = data.activeMemberships;
  document.querySelector('#metric-giving').textContent = money.format(data.donationTotal);
  document.querySelector('#metric-tasks').textContent = data.overdueTasks;
  document.querySelector('#gift-count').textContent = `${data.donationCount} recorded gifts`;
  document.querySelector('#recent-gifts').innerHTML = data.recentDonations.map((gift, index) => `
    <div class="gift-row"><span class="gift-avatar">${index % 2 ? '↗' : '♡'}</span>
      <span class="gift-details"><strong>${gift.contact_name}</strong><small>${gift.campaign} · ${dateFormat.format(new Date(`${gift.date}T00:00:00`))}</small></span>
      <span class="gift-amount">${money.format(gift.amount)}</span></div>`).join('');
}

function openDialog() {
  document.querySelector('#form-message').textContent = '';
  form.reset();
  dialog.showModal();
  form.elements.name.focus();
}

function closeDialog() {
  dialog.close();
}

document.querySelector('#new-contact').addEventListener('click', openDialog);
document.querySelector('#close-dialog').addEventListener('click', closeDialog);
document.querySelector('#cancel-contact').addEventListener('click', closeDialog);
document.querySelector('#view-all').addEventListener('click', () => { showAll = !showAll; renderContacts(); });
document.querySelector('#filter-button').addEventListener('click', (event) => {
  householdOnly = !householdOnly;
  event.currentTarget.classList.toggle('active-filter', householdOnly);
  event.currentTarget.querySelector('span').textContent = householdOnly ? 'Households' : 'Filters';
  renderContacts();
});
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderContacts, 100);
});
searchInput.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    searchInput.focus();
  }
});
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    searchInput.focus();
  }
});
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = document.querySelector('#form-message');
  const values = Object.fromEntries(new FormData(form));
  try {
    const response = await fetch('/api/contacts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not save this person.');
    await loadContacts();
    document.querySelector('#metric-contacts').textContent = allContacts.length;
    closeDialog();
    document.querySelector('#contacts').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    message.textContent = error.message;
  }
});

Promise.all([loadOverview(), loadContacts()]).catch((error) => {
  rows.innerHTML = `<tr><td colspan="5" class="empty">${error.message} Refresh the page to try again.</td></tr>`;
  document.querySelector('#recent-gifts').innerHTML = `<div class="empty">${error.message}</div>`;
});
