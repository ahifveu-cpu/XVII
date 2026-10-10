const CONFIG_KEY = "qos.supabase.config";
const SESSION_KEY = "qos.supabase.session";

export function readSupabaseConfig() {
  const sharedConfig = window.QOS_CONFIG;
  if (sharedConfig && typeof sharedConfig.supabaseUrl === "string" && typeof sharedConfig.supabaseAnonKey === "string"
    && sharedConfig.supabaseUrl.trim() && sharedConfig.supabaseAnonKey.trim()) {
    return {
      url: sharedConfig.supabaseUrl.trim().replace(/\/+$/, ""),
      anonKey: sharedConfig.supabaseAnonKey.trim(),
    };
  }
  try {
    const config = JSON.parse(localStorage.getItem(CONFIG_KEY) || "null");
    if (!config || typeof config.url !== "string" || typeof config.anonKey !== "string") return null;
    return { url: config.url.replace(/\/+$/, ""), anonKey: config.anonKey };
  } catch (error) {
    console.error("Не удалось прочитать конфигурацию XVII.", error);
    return null;
  }
}

export function validateSupabaseConfig(url, anonKey) {
  let parsedURL;
  try {
    parsedURL = new URL(url.trim());
  } catch {
    throw new Error("Укажите корректный URL проекта Supabase.");
  }
  if (parsedURL.protocol !== "https:" && parsedURL.hostname !== "localhost" && parsedURL.hostname !== "127.0.0.1") {
    throw new Error("Подключаться безопасно можно только по HTTPS.");
  }
  if (parsedURL.username || parsedURL.password || !anonKey.trim()) {
    throw new Error("Введите адрес проекта и публичный ключ anon/publishable — секретный service_role использовать нельзя.");
  }
  const legacyJWT = anonKey.trim().split(".");
  if (legacyJWT.length === 3) {
    try {
      const payload = JSON.parse(atob(legacyJWT[1].replace(/-/g, "+").replace(/_/g, "/")));
      if (payload.role === "service_role") {
        throw new Error("Ключ service_role даёт полный доступ к базе. В интерфейсе используйте только publishable/anon.");
      }
      if (payload.role && payload.role !== "anon") {
        throw new Error("Укажите публичный anon-ключ проекта, а не секретный ключ.");
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("service_role")) throw error;
      if (error instanceof Error && error.message.includes("публичный")) throw error;
    }
  }
  return { url: parsedURL.toString().replace(/\/+$/, ""), anonKey: anonKey.trim() };
}

function readSession() {
  try {
    const session = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
    if (!session || typeof session.access_token !== "string" || typeof session.refresh_token !== "string") return null;
    return session;
  } catch (error) {
    console.error("Не удалось восстановить сеанс XVII.", error);
    return null;
  }
}

export class SupabaseClient {
  constructor(config) {
    this.config = config;
    this.session = readSession();
  }

  setSession(session) {
    this.session = session;
    if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(SESSION_KEY);
  }

  async request(path, { method = "GET", body, headers = {}, publicRequest = false, retried = false } = {}) {
    const token = !publicRequest && this.session?.access_token ? this.session.access_token : this.config.anonKey;
    let response;
    try {
      response = await fetch(`${this.config.url}${path}`, {
        method,
        headers: {
          apikey: this.config.anonKey,
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      throw new Error(`Не удалось подключиться к XVII Cloud. Проверьте интернет и адрес проекта Supabase. ${error.message}`);
    }

    if (response.status === 401 && this.session?.refresh_token && !retried && !path.startsWith("/auth/v1/token")) {
      const refreshed = await this.request("/auth/v1/token?grant_type=refresh_token", {
        method: "POST",
        body: { refresh_token: this.session.refresh_token },
        publicRequest: true,
        retried: true,
      });
      this.setSession(refreshed);
      return this.request(path, { method, body, headers, publicRequest, retried: true });
    }
    if (!response.ok) {
      const details = await response.json().catch(() => null);
      const message = details?.msg || details?.message || details?.hint || details?.error_description || details?.error || response.statusText;
      throw new Error(`Supabase (${response.status}): ${message}`);
    }
    if (response.status === 204) return null;
    const contentType = response.headers.get("content-type") || "";
    return contentType.includes("application/json") ? response.json() : response.text();
  }

  async signIn(email, password) {
    const session = await this.request("/auth/v1/token?grant_type=password", {
      method: "POST",
      body: { email: email.trim(), password },
      publicRequest: true,
    });
    this.setSession(session);
    return session.user;
  }

  async signUp(email, password, fullName, companyName) {
    const result = await this.request("/auth/v1/signup", {
      method: "POST",
      body: {
        email: email.trim(),
        password,
        data: { full_name: fullName.trim(), company_name: companyName.trim() },
      },
      publicRequest: true,
    });
    if (result.access_token) this.setSession(result);
    return result;
  }

  async signOut() {
    try {
      if (this.session?.access_token) {
        await this.request("/auth/v1/logout", { method: "POST" });
      }
    } finally {
      this.setSession(null);
    }
  }

  async selectOne(table, query) {
    const rows = await this.request(`/rest/v1/${table}?${query}`);
    return rows?.[0] || null;
  }

  async selectMany(table, query) {
    return (await this.request(`/rest/v1/${table}?${query}`)) || [];
  }

  async insert(table, row) {
    return this.request(`/rest/v1/${table}?select=*`, {
      method: "POST",
      body: row,
      headers: { Prefer: "return=representation" },
    });
  }

  async update(table, id, row) {
    const result = await this.request(`/rest/v1/${table}?id=eq.${encodeURIComponent(id)}&select=*`, {
      method: "PATCH",
      body: row,
      headers: { Prefer: "return=representation" },
    });
    if (!result?.length) throw new Error("Запись не найдена или у пользователя нет доступа к её изменению.");
    return result[0];
  }

  async delete(table, id) {
    await this.request(`/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async rpc(name, parameters) {
    const result = await this.request(`/rest/v1/rpc/${name}`, { method: "POST", body: parameters });
    return Array.isArray(result) ? result[0] : result;
  }

  async invoke(name, body) {
    const result = await this.request(`/functions/v1/${name}`, { method: "POST", body });
    if (result?.error) throw new Error(result.error);
    return result;
  }
}

export function persistSupabaseConfig(config) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}
