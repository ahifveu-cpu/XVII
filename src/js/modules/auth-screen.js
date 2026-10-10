import { escapeHTML, icon } from "../components/icons.js";

export function renderAuthScreen({
  mode = "login",
  loading = false,
  error = "",
  message = "",
}) {
  const needsSetup = mode === "unconfigured";
  const isSignup = mode === "signup";
  const isSubmitting = loading ? "disabled" : "";

  return `
    <div class="auth-layout">
      <section class="auth-brand-panel">
        <a class="brand auth-brand" href="#" aria-label="XVII">
          <span class="brand-mark auth-brand-logo"><img src="./src/assets/xvii-logo.png" alt="" /></span>
          <span class="brand-copy"><strong>XVII</strong><small>CRM для сервиса</small></span>
        </a>
        <div class="auth-ambient" aria-hidden="true">
          <span class="ambient-orbit orbit-one"></span><span class="ambient-orbit orbit-two"></span>
          <span class="ambient-cloud cloud-one"></span><span class="ambient-cloud cloud-two"></span>
          <span class="ambient-spark spark-one">✦</span><span class="ambient-spark spark-two">✧</span>
          <span class="ambient-word">XVII</span>
        </div>
        <div class="auth-pitch">
          <span class="auth-eyebrow"><span class="eyebrow-dot"></span> РАБОЧЕЕ ПРОСТРАНСТВО КОМАНДЫ</span>
          <h1>Весь сервис.<br />В одном месте.</h1>
          <p>Заказы, клиенты, склад и касса — в одном облачном пространстве для всей команды.</p>
          <div class="auth-benefits">
            <span>${icon("clock")} 14 дней бесплатно · планы от 399 ₽</span>
            <span>${icon("check-square")} Защищённая облачная база PostgreSQL</span>
            <span>${icon("check-square")} Доступы сотрудников и филиалы</span>
            <span>${icon("check-square")} Данные компании видят только пользователи с доступом</span>
          </div>
        </div>
        <div class="auth-brand-footer">Бизнес работает. Команда успевает.</div>
      </section>
      <section class="auth-form-panel">
        <div class="auth-card">
          <span class="auth-icon">${icon(needsSetup ? "settings" : "users")}</span>
          <div class="eyebrow"><span class="eyebrow-dot"></span> ЗАЩИЩЁННАЯ CRM</div>
          <h2>${needsSetup ? "XVII Cloud не настроен" : isSignup ? "Создайте компанию" : "Вход в XVII"}</h2>
          <p class="auth-description">${needsSetup
    ? "Общую базу XVII должен один раз настроить администратор сервиса. Попросите его завершить настройку приложения."
    : isSignup
      ? "Укажите данные владельца: компания и 14-дневный пробный период создадутся автоматически. Первый филиал вы настроите после входа."
      : "Войдите по рабочей почте и паролю. Сотрудников добавляет владелец или сотрудник с выданным доступом."}</p>

          ${error ? `<div class="auth-message auth-message-error" role="alert">${escapeHTML(error)}</div>` : ""}
          ${message ? `<div class="auth-message auth-message-success" role="status">${escapeHTML(message)}</div>` : ""}

          ${needsSetup ? `
            <p class="auth-switch">Настройка публикации описана в <a href="./README.md#подключение-общей-облачной-базы" target="_blank" rel="noopener noreferrer">инструкции XVII Cloud</a>.</p>`
    : `
            <form id="auth-form" class="auth-fields">
              ${isSignup ? `<label class="form-field"><span>Название компании</span><input name="company_name" autocomplete="organization" minlength="2" maxlength="120" required /></label><label class="form-field"><span>Ваше имя</span><input name="full_name" autocomplete="name" minlength="2" maxlength="100" required /></label>` : ""}
              <label class="form-field"><span>Рабочая почта</span><input type="email" name="email" autocomplete="email" required /></label>
              <label class="form-field"><span>Пароль</span><input type="password" name="password" autocomplete="${isSignup ? "new-password" : "current-password"}" minlength="12" maxlength="128" required /><small>Не менее 12 символов.</small></label>
              <button class="button button-primary auth-submit" type="submit" ${isSubmitting}>${loading ? "Подключаемся…" : isSignup ? "Создать компанию" : "Войти в XVII"} ${icon("arrow-up-right")}</button>
              <button class="auth-switch-button" type="button" data-auth-mode="${isSignup ? "login" : "signup"}">${isSignup ? "Уже есть аккаунт? Войти" : "Первый запуск? Создать компанию"}</button>
            </form>
            `}
        </div>
        <span class="auth-privacy">Доступ к данным защищён настройками компании · Supabase Auth</span>
      </section>
    </div>`;
}
