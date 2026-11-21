'use strict';

const slug = new URLSearchParams(window.location.search).get('slug');
const title = document.getElementById('postTitle');
const body = document.getElementById('postBody');
const category = document.getElementById('postCategory');
const date = document.getElementById('postDate');

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderMarkdown(text) {
  return esc(text)
    .split(/\n{2,}/)
    .map((block) => {
      if (block.startsWith('### ')) return `<h3>${block.slice(4)}</h3>`;
      if (block.startsWith('## ')) return `<h2>${block.slice(3)}</h2>`;
      if (block.startsWith('# ')) return `<h2>${block.slice(2)}</h2>`;
      if (block.startsWith('- ')) {
        const items = block.split('\n').map((line) => `<li>${line.replace(/^-\s*/, '')}</li>`).join('');
        return `<ul>${items}</ul>`;
      }
      return `<p>${block.replace(/\n/g, '<br>')}</p>`;
    })
    .join('');
}

async function load() {
  if (!slug) {
    title.textContent = 'Post not found';
    return;
  }

  try {
    const res = await fetch(`/api/public/posts/${encodeURIComponent(slug)}`, { credentials: 'same-origin' });
    const post = await res.json();
    if (!res.ok) throw new Error(post?.error?.message || 'Not found');

    document.title = `${post.title} | Autopilot Forex`;
    title.textContent = post.title;
    category.textContent = post.vipOnly ? 'VIP' : post.category;
    category.className = `badge ${post.vipOnly ? 'vip' : ''}`;
    date.textContent = post.publishedAt
      ? new Date(post.publishedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })
      : '';

    if (post.locked) {
      body.innerHTML = `<p class="muted">${esc(post.excerpt || '')}</p>
        <div class="risk" style="margin-top:20px">This piece is part of the VIP research library.
        <a href="/#vip" class="positive">Compare memberships</a> to read it.</div>`;
      return;
    }

    body.innerHTML = renderMarkdown(post.body || '');
  } catch (error) {
    title.textContent = 'Post not found';
    body.innerHTML = `<p class="muted">${esc(error.message)}</p>`;
  }
}

load();
