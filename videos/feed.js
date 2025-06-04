// feed.js

// Supabase Config
const SUPABASE_URL = 'https://xtnaiqqtsbrrsddkanjk.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh0bmFpcXF0c2JycnNkZGthbmprIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDg4NDk0ODYsImV4cCI6MjA2NDQyNTQ4Nn0.tnBTErE7rkCxyDVvGMR3Hv7zWgMpdYPY1rJiTeQGzeo';
const BUCKET = 'gamegram';

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentUser = null;
let files = [];
let filesToUpload = [];

const uploadBtn = document.getElementById('uploadBtn');
const uploadInput = document.getElementById('uploadInput');
const searchInput = document.getElementById('searchInput');
const resultDiv = document.getElementById('result');
const galleryBand = document.getElementById('galleryBand');
const userInfo = document.getElementById('userInfo');
const logoutBtn = document.getElementById('logoutBtn');

function clearResultLogs() {
  resultDiv.innerHTML = '';
}

function appendResultLog(message, isError = false) {
  const p = document.createElement('p');
  p.textContent = message;
  p.style.margin = '5px 0';
  p.style.color = isError ? '#b00020' : '#00796b';
  p.style.fontWeight = isError ? '700' : 'normal';
  resultDiv.appendChild(p);
  resultDiv.scrollTop = resultDiv.scrollHeight;
}

function renderGallery(filter = '') {
  galleryBand.innerHTML = '';
  const filtered = files.filter(f => f.name.toLowerCase().includes(filter));
  if (filtered.length === 0) {
    appendResultLog('No matching files.');
    return;
  }
  for (const file of filtered) {
    const item = document.createElement('div');
    item.className = 'gallery-item';
    const img = document.createElement('img');
    img.src = file.url;
    img.alt = file.name;
    item.appendChild(img);
    const caption = document.createElement('div');
    caption.className = 'caption';
    caption.textContent = file.name;
    item.appendChild(caption);
    galleryBand.appendChild(item);
  }
}

async function fetchFiles() {
  clearResultLogs();
  appendResultLog('Loading files...');
  const { data, error } = await supabaseClient.storage.from(BUCKET).list('images', { limit: 100 });
  if (error) {
    appendResultLog(`Error loading files: ${error.message}`, true);
    return;
  }
  const publicFiles = await Promise.all(
    data.map(async file => {
      const { data: urlData } = supabaseClient.storage.from(BUCKET).getPublicUrl(`images/${file.name}`);
      return { name: file.name, url: urlData.publicUrl };
    })
  );
  files = publicFiles;
  renderGallery(searchInput.value.trim().toLowerCase());
  appendResultLog('Files loaded.');
}

uploadInput.addEventListener('change', () => {
  filesToUpload = Array.from(uploadInput.files);
  uploadBtn.disabled = filesToUpload.length === 0;
});

uploadBtn.addEventListener('click', async () => {
  clearResultLogs();
  uploadBtn.disabled = true;
  uploadBtn.textContent = 'Uploading...';
  for (const file of filesToUpload) {
    const filePath = `images/${Date.now()}_${file.name}`;
    const { error } = await supabaseClient.storage.from(BUCKET).upload(filePath, file);
    if (error) {
      appendResultLog(`Upload error: ${error.message}`, true);
    } else {
      appendResultLog(`Uploaded ${file.name}`);
    }
  }
  await fetchFiles();
  uploadBtn.textContent = 'Upload';
  uploadInput.value = '';
  filesToUpload = [];
});

searchInput.addEventListener('input', () => {
  clearResultLogs();
  renderGallery(searchInput.value.trim().toLowerCase());
});

logoutBtn.addEventListener('click', async () => {
  await supabaseClient.auth.signOut();
  location.href = 'login.html';
});

(async () => {
  const {
    data: { session }
  } = await supabaseClient.auth.getSession();
  currentUser = session?.user || null;
  if (!currentUser) {
    location.href = 'login.html';
  } else {
    userInfo.textContent = `Logged in as ${currentUser.email}`;
    await fetchFiles();
  }
})();
