import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

// client.ts reads NEXUSMIND_BASE_URL/NEXUSMIND_API_KEY once at module load time,
// so the env vars must be set BEFORE the dynamic import below.
process.env.NEXUSMIND_BASE_URL = 'http://fake-backend.test'
process.env.NEXUSMIND_API_KEY = 'nm_test_key'

const {
  listTasks,
  listMyTasks,
  getTask,
  createTask,
  updateTask,
  deleteTask,
  assignTask,
  unassignTask,
  addTaskComment,
  listTaskComments,
  addTaskLabel,
  linkTaskSpec,
  listTaskSpecs,
  resolveTasksForSpec,
  listSprints,
  createSprint,
  createSprintRetrospective,
} = await import('./client.js')

interface RecordedCall {
  url: string
  init?: RequestInit
}

let calls: RecordedCall[] = []
let mockResponse: { status: number; body: unknown } = { status: 200, body: [] }
const originalFetch = globalThis.fetch

beforeEach(() => {
  calls = []
  mockResponse = { status: 200, body: [] }
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return {
      ok: mockResponse.status >= 200 && mockResponse.status < 300,
      status: mockResponse.status,
      statusText: 'Mock Status',
      json: async () => mockResponse.body,
      // Real fetch's text() always resolves to a string; JSON.stringify(undefined)
      // is `undefined`, not `"undefined"`, so guard for the no-body case here to
      // match actual Response semantics.
      text: async () => mockResponse.body === undefined ? '' : JSON.stringify(mockResponse.body),
    } as Response
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

test('listTasks calls GET /v1/tasks with no query params by default', async () => {
  mockResponse = { status: 200, body: [{ id: 't1', project: 'acme', title: 'Foo', status: 'todo' }] }
  const result = await listTasks()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://fake-backend.test/v1/tasks')
  assert.equal(calls[0].init?.method, undefined)
  assert.deepEqual(result, [{ id: 't1', project: 'acme', title: 'Foo', status: 'todo' }])
})

test('listTasks forwards project/status/sprint/label/assignee/limit as query params', async () => {
  await listTasks({ project: 'acme', status: 'todo', sprint: 's1', label: 'bug', assignee: 'u1', limit: 5 })
  const url = new URL(calls[0].url)
  assert.equal(url.pathname, '/v1/tasks')
  assert.equal(url.searchParams.get('project'), 'acme')
  assert.equal(url.searchParams.get('status'), 'todo')
  assert.equal(url.searchParams.get('sprint'), 's1')
  assert.equal(url.searchParams.get('label'), 'bug')
  assert.equal(url.searchParams.get('assignee'), 'u1')
  assert.equal(url.searchParams.get('limit'), '5')
})

test('listMyTasks always sets assignee=me and never accepts a user id', async () => {
  await listMyTasks({ project: 'acme', status: 'todo' })
  const url = new URL(calls[0].url)
  assert.equal(url.pathname, '/v1/tasks')
  assert.equal(url.searchParams.get('assignee'), 'me')
  assert.equal(url.searchParams.get('project'), 'acme')
  assert.equal(url.searchParams.get('status'), 'todo')
})

test('getTask calls GET /v1/tasks/:id and URL-encodes the id', async () => {
  mockResponse = { status: 200, body: { id: 't 1', project: 'acme', title: 'Foo', status: 'todo' } }
  const result = await getTask('t 1')
  assert.equal(calls[0].url, 'http://fake-backend.test/v1/tasks/t%201')
  assert.equal(result.id, 't 1')
})

test('createTask calls POST /v1/tasks with only provided fields', async () => {
  mockResponse = { status: 201, body: { id: 't1', project: 'acme', title: 'Foo', status: 'backlog' } }
  await createTask({ project: 'acme', title: 'Foo', priority: 'high' })
  assert.equal(calls[0].url, 'http://fake-backend.test/v1/tasks')
  assert.equal(calls[0].init?.method, 'POST')
  const body = JSON.parse(calls[0].init?.body as string)
  assert.deepEqual(body, { project: 'acme', title: 'Foo', priority: 'high' })
})

test('updateTask calls PATCH /v1/tasks/:id with only provided fields', async () => {
  mockResponse = { status: 200, body: { id: 't1', project: 'acme', title: 'Foo', status: 'in_progress' } }
  await updateTask('t1', { status: 'in_progress' })
  assert.equal(calls[0].url, 'http://fake-backend.test/v1/tasks/t1')
  assert.equal(calls[0].init?.method, 'PATCH')
  const body = JSON.parse(calls[0].init?.body as string)
  assert.deepEqual(body, { status: 'in_progress' })
})

test('deleteTask calls DELETE /v1/tasks/:id', async () => {
  mockResponse = { status: 204, body: undefined }
  await deleteTask('t1')
  assert.equal(calls[0].url, 'http://fake-backend.test/v1/tasks/t1')
  assert.equal(calls[0].init?.method, 'DELETE')
})

test('assignTask calls POST /v1/tasks/:id/assignees with user_ids', async () => {
  mockResponse = { status: 200, body: [{ id: 'u1', name: 'Sarah' }] }
  await assignTask('t1', ['u1', 'u2'])
  assert.equal(calls[0].url, 'http://fake-backend.test/v1/tasks/t1/assignees')
  assert.equal(calls[0].init?.method, 'POST')
  const body = JSON.parse(calls[0].init?.body as string)
  assert.deepEqual(body, { user_ids: ['u1', 'u2'] })
})

test('unassignTask calls DELETE /v1/tasks/:id/assignees/:user_id', async () => {
  mockResponse = { status: 204, body: undefined }
  await unassignTask('t1', 'u1')
  assert.equal(calls[0].url, 'http://fake-backend.test/v1/tasks/t1/assignees/u1')
  assert.equal(calls[0].init?.method, 'DELETE')
})

test('addTaskComment calls POST /v1/tasks/:id/comments with body', async () => {
  mockResponse = { status: 201, body: { id: 'c1', task_id: 't1', user_id: 'u1', body: 'hi' } }
  await addTaskComment('t1', 'hi')
  assert.equal(calls[0].url, 'http://fake-backend.test/v1/tasks/t1/comments')
  assert.equal(calls[0].init?.method, 'POST')
  const body = JSON.parse(calls[0].init?.body as string)
  assert.deepEqual(body, { body: 'hi' })
})

test('listTaskComments calls GET /v1/tasks/:id/comments', async () => {
  mockResponse = { status: 200, body: [] }
  await listTaskComments('t1')
  assert.equal(calls[0].url, 'http://fake-backend.test/v1/tasks/t1/comments')
})

test('addTaskLabel calls POST /v1/tasks/:id/labels with label', async () => {
  mockResponse = { status: 200, body: ['bug'] }
  await addTaskLabel('t1', 'bug')
  assert.equal(calls[0].url, 'http://fake-backend.test/v1/tasks/t1/labels')
  const body = JSON.parse(calls[0].init?.body as string)
  assert.deepEqual(body, { label: 'bug' })
})

test('linkTaskSpec calls POST /v1/tasks/:id/spec-links with spec_change_name', async () => {
  mockResponse = { status: 201, body: undefined }
  await linkTaskSpec('t1', 'team-tasks')
  assert.equal(calls[0].url, 'http://fake-backend.test/v1/tasks/t1/spec-links')
  const body = JSON.parse(calls[0].init?.body as string)
  assert.deepEqual(body, { spec_change_name: 'team-tasks' })
})

test('listTaskSpecs calls GET /v1/tasks/:id/spec-links', async () => {
  mockResponse = { status: 200, body: ['team-tasks'] }
  const result = await listTaskSpecs('t1')
  assert.equal(calls[0].url, 'http://fake-backend.test/v1/tasks/t1/spec-links')
  assert.deepEqual(result, ['team-tasks'])
})

test('resolveTasksForSpec calls POST /v1/tasks/resolve-by-spec with spec_change_name', async () => {
  mockResponse = { status: 200, body: { resolved: ['t1', 't2'] } }
  const result = await resolveTasksForSpec('team-tasks')
  assert.equal(calls[0].url, 'http://fake-backend.test/v1/tasks/resolve-by-spec')
  assert.equal(calls[0].init?.method, 'POST')
  const body = JSON.parse(calls[0].init?.body as string)
  assert.deepEqual(body, { spec_change_name: 'team-tasks' })
  assert.deepEqual(result.resolved, ['t1', 't2'])
})

test('listSprints forwards project/status query params', async () => {
  mockResponse = { status: 200, body: [] }
  await listSprints({ project: 'acme', status: 'active' })
  const url = new URL(calls[0].url)
  assert.equal(url.pathname, '/v1/sprints')
  assert.equal(url.searchParams.get('project'), 'acme')
  assert.equal(url.searchParams.get('status'), 'active')
})

test('createSprint calls POST /v1/sprints with only provided fields', async () => {
  mockResponse = { status: 201, body: { id: 's1', project: 'acme', name: 'Sprint 42', status: 'planned' } }
  await createSprint({ project: 'acme', name: 'Sprint 42' })
  assert.equal(calls[0].url, 'http://fake-backend.test/v1/sprints')
  assert.equal(calls[0].init?.method, 'POST')
  const body = JSON.parse(calls[0].init?.body as string)
  assert.deepEqual(body, { project: 'acme', name: 'Sprint 42' })
})

test('createSprintRetrospective calls POST /v1/sprints/:id/retrospectives with retro fields', async () => {
  mockResponse = { status: 201, body: { id: 'r1', sprint_id: 's1', went_well: 'shipped fast' } }
  await createSprintRetrospective('s1', { went_well: 'shipped fast' })
  assert.equal(calls[0].url, 'http://fake-backend.test/v1/sprints/s1/retrospectives')
  assert.equal(calls[0].init?.method, 'POST')
  const body = JSON.parse(calls[0].init?.body as string)
  assert.deepEqual(body, { went_well: 'shipped fast' })
})

// ── Empty-body non-204 responses (live e2e regression) ──────────────────────
//
// The backend returns 201 CREATED with an EMPTY body (content-length 0) for
// POST /v1/tasks/:id/spec-links (and possibly other relationship POSTs). A
// real fetch Response in that situation throws SyntaxError from res.json()
// ("Unexpected end of JSON input") because there is no JSON to parse — even
// though the request succeeded and the link WAS persisted server-side. The
// shared beforeEach mock above is too lenient (its json() just resolves
// mockResponse.body, even when that's `undefined`), so it never reproduced
// this bug. These tests install a raw-fetch stub that mirrors real fetch:
// json() throws on an empty body, text() returns the actual empty string.

test('linkTaskSpec resolves (does not throw) when the backend returns 201 with an empty body', async () => {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return {
      ok: true,
      status: 201,
      statusText: 'Created',
      json: async () => { throw new SyntaxError('Unexpected end of JSON input') },
      text: async () => '',
    } as Response
  }) as typeof fetch

  const result = await linkTaskSpec('t1', 'team-tasks')
  assert.equal(result, undefined)
  assert.equal(calls[0].url, 'http://fake-backend.test/v1/tasks/t1/spec-links')
})

test('a normal 200 response with a real JSON body still parses correctly', async () => {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const text = JSON.stringify(['team-tasks', 'other-spec'])
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => JSON.parse(text),
      text: async () => text,
    } as Response
  }) as typeof fetch

  const result = await listTaskSpecs('t1')
  assert.deepEqual(result, ['team-tasks', 'other-spec'])
})
