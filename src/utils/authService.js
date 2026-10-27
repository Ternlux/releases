import axios from 'axios';

/**
 * Account authentication against the Ternlux backend (../backend).
 * The JWT is kept in localStorage under 'auth-token' (App.js gates on it)
 * and the user profile under 'auth-user'.
 */

// Inlined by react-scripts at build time from .env; the fallback ships if that
// file is absent, so it points at production rather than a dev machine.
const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || 'https://api.ternlux.com';

const api = axios.create({ baseURL: `${BACKEND_URL}/api/auth` });

const TOKEN_KEY = 'auth-token';
const USER_KEY = 'auth-user';

function persistSession({ token, user }) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function isLoggedIn() {
  return Boolean(getToken());
}

export function getStoredUser() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function signOut() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

function errorMessage(err, fallback) {
  return (
    err.response?.data?.error ||
    err.response?.data?.message ||
    (err.request && !err.response ? 'Unable to reach the Ternlux server. Please check your connection.' : null) ||
    fallback
  );
}

/** Register a free account; the backend emails a verification link. */
export async function register({ name, email, password }) {
  try {
    const { data } = await api.post('/register', { name, email, password });
    return data;
  } catch (err) {
    return {
      success: false,
      error: errorMessage(err, 'Registration failed. Please try again.'),
      code: err.response?.data?.code
    };
  }
}

/** Sign in with email/password. Stores the JWT on success. */
export async function login({ email, password }) {
  try {
    const { data } = await api.post('/login', { email, password });
    if (data.success && data.token) persistSession(data);
    return data;
  } catch (err) {
    return {
      success: false,
      error: errorMessage(err, 'Sign in failed. Please try again.'),
      code: err.response?.data?.code
    };
  }
}

/** Re-send the email verification link. */
export async function resendVerification(email) {
  try {
    const { data } = await api.post('/resend-verification', { email });
    return data;
  } catch (err) {
    return { success: false, error: errorMessage(err, 'Could not resend the verification email.') };
  }
}

/** Ask the backend to email a 6-digit password reset code. */
export async function requestPasswordReset(email) {
  try {
    const { data } = await api.post('/forgot-password', { email });
    return data;
  } catch (err) {
    return { success: false, error: errorMessage(err, 'Could not send the reset code. Please try again.') };
  }
}

/** Set a new password with the emailed code. Signs in (stores the JWT) on success. */
export async function resetPassword({ email, code, password }) {
  try {
    const { data } = await api.post('/reset-password', { email, code, password });
    if (data.success && data.token) persistSession(data);
    return data;
  } catch (err) {
    return {
      success: false,
      error: errorMessage(err, 'Could not reset the password. Please try again.'),
      code: err.response?.data?.code
    };
  }
}

/**
 * Google sign-in: the Electron main process runs the browser OAuth flow,
 * then the backend exchanges the code and issues our JWT.
 */
export async function loginWithGoogle() {
  if (!window.electronAPI?.auth?.googleLogin) {
    return { success: false, error: 'Google sign-in is only available in the desktop app.' };
  }

  const flow = await window.electronAPI.auth.googleLogin();
  if (!flow?.success) {
    return { success: false, error: flow?.message || 'Google sign-in was cancelled.' };
  }

  try {
    const { data } = await api.post('/google', {
      code: flow.code,
      redirectUri: flow.redirectUri,
      codeVerifier: flow.codeVerifier
    });
    if (data.success && data.token) persistSession(data);
    return data;
  } catch (err) {
    return { success: false, error: errorMessage(err, 'Google sign-in failed. Please try again.') };
  }
}

/**
 * Apple sign-in: the Electron main process opens the browser and the backend
 * brokers the whole OAuth exchange, so the result already contains our JWT.
 */
/* Apple sign-in disabled
export async function loginWithApple() {
  if (!window.electronAPI?.auth?.appleLogin) {
    return { success: false, error: 'Apple sign-in is only available in the desktop app.' };
  }

  const result = await window.electronAPI.auth.appleLogin();
  if (!result?.success || !result.token) {
    return { success: false, error: result?.message || 'Apple sign-in was cancelled.' };
  }

  persistSession(result);
  return { success: true, token: result.token, user: result.user };
}
*/

/** Fetch the current user with the stored JWT; clears the session if invalid. */
export async function fetchCurrentUser() {
  const token = getToken();
  if (!token) return null;
  try {
    const { data } = await api.get('/me', { headers: { Authorization: `Bearer ${token}` } });
    if (data.success && data.user) {
      localStorage.setItem(USER_KEY, JSON.stringify(data.user));
      return data.user;
    }
    return getStoredUser();
  } catch (err) {
    if (err.response?.status === 401) signOut();
    return err.response?.status === 401 ? null : getStoredUser();
  }
}
