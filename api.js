(function () {
  async function request(path, options = {}) {
    const headers = options.body instanceof FormData ? (options.headers || {}) : { 'Content-Type': 'application/json', ...(options.headers || {}) };
    const response = await fetch(`/api${path}`, { credentials: 'include', ...options, headers });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const error = new Error(body.error || 'Request failed.');
      error.status = response.status;
      throw error;
    }
    return response.status === 204 ? null : response.json();
  }
  window.sinyarApi = { request, json: body => ({ body: JSON.stringify(body) }) };
}());
