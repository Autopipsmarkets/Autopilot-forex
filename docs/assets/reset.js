'use strict';

const form = document.getElementById('resetForm');
const message = document.getElementById('resetMessage');
const button = document.getElementById('resetBtn');
const token = new URLSearchParams(window.location.search).get('token');

if (!token) {
  form.hidden = true;
  message.textContent = 'This page needs a reset link. Request a new one from the sign-in screen.';
}

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  message.textContent = '';
  button.disabled = true;

  try {
    const res = await fetch('/api/auth/reset-password', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'autopilot-forex' },
      body: JSON.stringify({ token, password: document.getElementById('password').value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || 'Could not reset the password');

    form.hidden = true;
    message.textContent = 'Password updated. You can sign in with the new one.';
    message.className = 'small positive';
  } catch (error) {
    message.textContent = error.message;
    message.className = 'small negative';
    button.disabled = false;
  }
});
