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
let currentUser = null;
let editId = null;

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
  const tag = document.querySelector('#tag-filter').value;
  const matching = contacts.filter((contact) => {
    const words = `${contact.id} ${contact.name} ${contact.email} ${contact.phone}`.toLocaleLowerCase();
    return words.includes(search) && (!householdOnly || Boolean(contact.household_id)) && (!tag || contact.tags.includes(tag));
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
  const filter=document.querySelector('#tag-filter'), prior=filter.value;
  filter.innerHTML='<option value="">All tags</option>'+[...new Set(contacts.flatMap(c=>c.tags))].sort().map(t=>`<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');filter.value=prior;
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
  window.activeContact = contact;
  const details = [
    ['Contact ID', contact.id], ['Name', contact.name], ['Email', contact.email || '—'],
    ['Phone', contact.phone || '—'], ['Household', contact.household_name ? `${contact.household_id} · ${contact.household_name}` : '—'],
    ['Tags', contact.tags.length ? contact.tags.join(', ') : '—'], ['Notes', contact.notes || '—'],
    ['Email permission', contact.email_opt_in ? 'Granted' : 'Not granted']
  ];
  document.querySelector('#detail-subhead').textContent = `${contact.name} · ${contact.id}`;
  document.querySelector('#contact-detail-card').innerHTML = `
    <dl class="detail-grid">${details.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>
    <div class="dialog-actions">${currentUser?.role !== 'viewer' ? '<button class="secondary-button" id="edit-selected">Edit</button><button class="secondary-button" id="archive-selected">Archive</button>' : ''}</div>
    <section class="linked-records"><h2>Linked records</h2><p>Memberships: ${contact.memberships.length ? contact.memberships.length : 'none saved yet'}</p><p>Donations: ${contact.donations.length ? contact.donations.length : 'none saved yet'}</p><p>Tasks: ${contact.tasks.length ? contact.tasks.length : 'none saved yet'}</p></section>`;
  if(contact.household_id) {
    const h=await api('/api/households/'+encodeURIComponent(contact.household_id));
    document.querySelector('#contact-detail-card').insertAdjacentHTML('beforeend','<h2>Household members</h2>'+h.contacts.map(p=>'<p>'+escapeHtml(p.name)+' ('+escapeHtml(p.id)+')</p>').join(''));
  }
  setScreen('contact-details');
}

function openDialog(contact = null) {
  if(currentUser?.role === 'viewer') return;
  editId = contact?.id || null;
  form.reset();
  document.querySelector('#contact-dialog-title').textContent=editId?'Edit Contact':'Add Contact';
  document.querySelector('#contact-id').readOnly=Boolean(editId);
  if(contact){for(const key of ['id','name','email','phone','household_id','notes']) form.elements[key].value=contact[key]||'';
    form.elements.tags.value=contact.tags.join(', ');form.elements.email_opt_in.checked=contact.email_opt_in;}
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
document.querySelectorAll('[data-add-contact]').forEach((button) => button.addEventListener('click', () => openDialog()));
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
document.querySelector('#tag-filter').addEventListener('change',renderContacts);
document.querySelector('#contact-detail-card').addEventListener('click',async e=>{
 if(e.target.id==='edit-selected') openDialog(window.activeContact);
 if(e.target.id==='archive-selected' && confirm('Archive this contact?')){
  try{await api('/api/contacts/'+encodeURIComponent(selectedContactId)+'/archive',{method:'POST'});await refreshData();await loadAudit();setScreen('contacts');}catch(error){showError(error);}
 }
});
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
    const response = await fetch(editId?'/api/contacts/'+encodeURIComponent(editId):'/api/contacts', {
      method: editId?'PUT':'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
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
    document.querySelector('#screen-contacts').scrollIntoView({ behavior: 'smooth', block: 'start' });
    await loadAudit();
  } catch (error) {
    formMessage.textContent = error.message;
  }
});

async function api(url,options={}){
 const response=await fetch(url,options);const result=await response.json();
 if(!response.ok) throw new Error(result.error||'Request failed.');return result;
}
async function loadAudit(){
 const entries=await api('/api/audit');
 document.querySelector('#audit-entries').innerHTML=entries.map(a=>'<li>'+escapeHtml(a.actor)+' '+escapeHtml(a.action)+' '+escapeHtml(a.record_id)+' at '+escapeHtml(a.at)+'</li>').join('');
}
async function initializeSession(){
 try{currentUser=await api('/api/me');}catch{currentUser=null;}
 document.querySelector('#sign-in-panel').hidden=Boolean(currentUser);
 document.querySelector('#signed-in-panel').hidden=!currentUser;
 document.querySelector('#current-user').textContent=currentUser?currentUser.id+' ('+currentUser.role+')':'';
 document.querySelectorAll('[data-add-contact]').forEach(b=>b.hidden=!currentUser||currentUser.role==='viewer');
 document.querySelector('#load-practice').hidden=!currentUser||currentUser.role==='viewer';
 if(!currentUser){rows.innerHTML='<tr><td colspan="5">Sign in to view contacts.</td></tr>';setScreen('settings');return;}
 await Promise.all([loadHouseholdOptions(),refreshData(),loadAudit()]);
}
document.querySelector('#sign-in-form').addEventListener('submit',async e=>{
 e.preventDefault();const f=e.currentTarget;
 try{await api('/api/sign-in',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:f.elements.username.value,password:f.elements.password.value})});
 document.querySelector('#auth-message').textContent='';await initializeSession();setScreen('contacts');
 }catch(error){document.querySelector('#auth-message').textContent=error.message;}
});
document.querySelector('#sign-out').addEventListener('click',async()=>{await api('/api/sign-out',{method:'POST'});await initializeSession();});
document.querySelector('#load-practice').addEventListener('click',async()=>{
 try{const result=await api('/api/load-practice',{method:'POST'});await refreshData();await loadHouseholdOptions();document.querySelector('#contact-message').textContent='Practice data loaded: '+result.stored+' stored, '+result.active+' active.';}
 catch(error){showError(error);}
});
setScreen(location.hash.slice(1) || 'dashboard');
initializeSession().catch((error) => {
  document.querySelector('#contact-rows').innerHTML = `<tr><td colspan="5" class="empty">${escapeHtml(error.message)}</td></tr>`;
  document.querySelector('#contact-message').textContent = error.message;
  document.querySelector('#contact-message').hidden = false;
});
