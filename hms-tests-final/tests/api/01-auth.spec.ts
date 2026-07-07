import { test, expect } from '@playwright/test';
import { BASE, USERS, getToken } from '../helpers/api';

test.describe('POST /api/auth/login', () => {

  test('returns 200 + token for valid HR credentials', async ({ request }) => {
    const res  = await request.post(`${BASE}/api/auth/login`, {
      data: { email: USERS.hr.email, password: 'password123' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.token).toBeTruthy();
    expect(body.user.email).toBe(USERS.hr.email);
    expect(body.user.persona).toBe('hr_recruiter');
    expect(body.user).not.toHaveProperty('password_hash');
  });

  test('returns 200 for every seeded persona', async ({ request }) => {
    for (const [, cred] of Object.entries(USERS)) {
      const res = await request.post(`${BASE}/api/auth/login`, {
        data: { email: cred.email, password: 'password123' },
      });
      expect(res.status(), `${cred.email} should log in`).toBe(200);
      const body = await res.json();
      expect(body.user.persona).toBe(cred.persona);
    }
  });

  test('returns 401 for wrong password', async ({ request }) => {
    const res = await request.post(`${BASE}/api/auth/login`, {
      data: { email: USERS.hr.email, password: 'wrongpassword' },
    });
    expect(res.status()).toBe(401);
  });

  test('returns 401 for non-existent email', async ({ request }) => {
    const res = await request.post(`${BASE}/api/auth/login`, {
      data: { email: 'nobody@digitalpaani.com', password: 'password123' },
    });
    expect(res.status()).toBe(401);
  });

  test('returns 400 when email is missing', async ({ request }) => {
    const res = await request.post(`${BASE}/api/auth/login`, {
      data: { password: 'password123' },
    });
    expect(res.status()).toBe(400);
  });

  test('returns 400 when password is missing', async ({ request }) => {
    const res = await request.post(`${BASE}/api/auth/login`, {
      data: { email: USERS.hr.email },
    });
    expect(res.status()).toBe(400);
  });
});

test.describe('GET /api/auth/me', () => {

  test('returns current user for valid token', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const res   = await request.get(`${BASE}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.user.email).toBe(USERS.hr.email);
    expect(body.user.persona).toBe('hr_recruiter');
  });

  test('returns 401 with no token', async ({ request }) => {
    const res = await request.get(`${BASE}/api/auth/me`);
    expect(res.status()).toBe(401);
  });

  test('returns 401 with tampered token', async ({ request }) => {
    const res = await request.get(`${BASE}/api/auth/me`, {
      headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.fake.payload' },
    });
    expect(res.status()).toBe(401);
  });
});

test('GET /health returns ok', async ({ request }) => {
  const res  = await request.get(`${BASE}/health`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('ok');
});
