/**
 * Secrets that used to live in config.json (Stage B, F2).
 *
 * Six values were stored in plaintext next to ordinary settings, and `config:get`,
 * `webhooks:list`, `org:getTrigger` and the `config:changed` broadcast handed all of them
 * to the renderer, where the Settings inputs were bound to them:
 *
 *   slackSigningSecret     the Slack app's signing secret
 *   slackBotToken          the Slack bot token
 *   groqApiKey             the user's Groq key (voice dictation)
 *   orgTrigger.apiKey      the peer-messaging key
 *   webhookTriggers[].secret   one shared secret per inbound webhook endpoint
 *   webhookSecret          the legacy single-webhook secret (folded into `legacy`)
 *
 * After this change none of them is persisted in config.json (once migrated) and none
 * ever crosses to the renderer. They live in the same encrypted store as every other
 * credential, under `cfg:*` refs. The renderer is told only WHETHER one is set; it
 * replaces one through a write-only call, and a webhook secret reaches the clipboard
 * through the main process, so a page that has been tricked into running script can
 * never read one.
 *
 * This module is pure: the vault and the config arrive as arguments, so every rule is
 * tested without Electron (test/config-secrets.test.cjs).
 */

export type ConfigSecretName = 'slackSigningSecret' | 'slackBotToken' | 'groqApiKey' | 'orgKey';
export const CONFIG_SECRET_NAMES: readonly ConfigSecretName[] = ['slackSigningSecret', 'slackBotToken', 'groqApiKey', 'orgKey'];

/** Top-level config keys that must never be persisted, sent to the renderer, or accepted
 *  from it through the general config update. */
export const SECRET_CONFIG_KEYS = ['slackSigningSecret', 'slackBotToken', 'groqApiKey', 'webhookSecret'] as const;

export const WEBHOOK_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

export const configSecretRef = (n: ConfigSecretName): string => `cfg:${n}`;
export const webhookSecretRef = (id: string): string => `cfg:webhook:${id}`;

export interface SecretVault {
  get(ref: string): string | undefined;
  set(ref: string, value: string): { ok: boolean; error?: string };
  has(ref: string): boolean;
  delete(ref: string): { ok: boolean; error?: string };
  /** Whether a NEW secret can be stored securely right now (never a plaintext fallback). */
  available(): boolean;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export interface SecretsSet {
  slackSigningSecret: boolean;
  slackBotToken: boolean;
  groqApiKey: boolean;
  orgKey: boolean;
  /** webhook id → whether that endpoint has a secret */
  webhooks: Record<string, boolean>;
  /** How many secrets are STILL in plaintext in config.json (0 once migrated). A number
   *  above zero means secure storage was unavailable and the Settings screen should say so. */
  plaintextRemaining: number;
}

/** The plaintext still sitting in a stored config, by ref. Empty once migrated. */
export function legacyPlaintext(cfg: Rec): Array<{ ref: string; value: string }> {
  const out: Array<{ ref: string; value: string }> = [];
  const add = (ref: string, v: unknown): void => { const s = text(v); if (s) out.push({ ref, value: s }); };
  add(configSecretRef('slackSigningSecret'), cfg.slackSigningSecret);
  add(configSecretRef('slackBotToken'), cfg.slackBotToken);
  add(configSecretRef('groqApiKey'), cfg.groqApiKey);
  if (isRec(cfg.orgTrigger)) add(configSecretRef('orgKey'), cfg.orgTrigger.apiKey);
  if (Array.isArray(cfg.webhookTriggers)) {
    for (const t of cfg.webhookTriggers) {
      if (isRec(t) && typeof t.id === 'string' && WEBHOOK_ID_RE.test(t.id)) add(webhookSecretRef(t.id), t.secret);
    }
  }
  // the pre-multi-endpoint secret: only a fallback for the `legacy` endpoint
  if (text(cfg.webhookSecret) && !out.some((m) => m.ref === webhookSecretRef('legacy'))) {
    add(webhookSecretRef('legacy'), cfg.webhookSecret);
  }
  return out;
}

/** A copy of the config with every secret value removed. Pure; never mutates its input. */
export function stripSecrets<T extends object>(cfg: T): T {
  const out: Rec = { ...(cfg as Rec) };
  for (const k of SECRET_CONFIG_KEYS) delete out[k];
  if (Array.isArray(out.webhookTriggers)) {
    out.webhookTriggers = out.webhookTriggers.map((t) => {
      if (!isRec(t)) return t;
      const { secret: _secret, ...rest } = t;
      void _secret;
      return rest;
    });
  }
  if (isRec(out.orgTrigger)) out.orgTrigger = { ...out.orgTrigger, apiKey: '' };
  return out as T;
}

/** Whether a secret exists, in the vault or (not yet migrated) in the stored config. */
export function hasConfigSecret(name: ConfigSecretName, stored: Rec, vault: SecretVault): boolean {
  return vault.has(configSecretRef(name)) || legacyPlaintext(stored).some((m) => m.ref === configSecretRef(name));
}

export function hasWebhookSecret(id: string, stored: Rec, vault: SecretVault): boolean {
  if (!WEBHOOK_ID_RE.test(id)) return false;
  return vault.has(webhookSecretRef(id)) || legacyPlaintext(stored).some((m) => m.ref === webhookSecretRef(id));
}

/** MAIN-ONLY. The vault's value, else whatever plaintext a not-yet-migrated config still holds. */
export function readConfigSecret(name: ConfigSecretName, stored: Rec, vault: SecretVault): string | undefined {
  const ref = configSecretRef(name);
  return vault.get(ref) ?? legacyPlaintext(stored).find((m) => m.ref === ref)?.value;
}

export function readWebhookSecret(id: string, stored: Rec, vault: SecretVault): string | undefined {
  if (!WEBHOOK_ID_RE.test(id)) return undefined;
  const ref = webhookSecretRef(id);
  return vault.get(ref) ?? legacyPlaintext(stored).find((m) => m.ref === ref)?.value;
}

export function secretsSet(stored: Rec, vault: SecretVault): SecretsSet {
  const webhooks: Record<string, boolean> = {};
  if (Array.isArray(stored.webhookTriggers)) {
    for (const t of stored.webhookTriggers) {
      if (isRec(t) && typeof t.id === 'string') webhooks[t.id] = hasWebhookSecret(t.id, stored, vault);
    }
  }
  return {
    slackSigningSecret: hasConfigSecret('slackSigningSecret', stored, vault),
    slackBotToken: hasConfigSecret('slackBotToken', stored, vault),
    groqApiKey: hasConfigSecret('groqApiKey', stored, vault),
    orgKey: hasConfigSecret('orgKey', stored, vault),
    webhooks,
    plaintextRemaining: legacyPlaintext(stored).length
  };
}

/** What the renderer is allowed to see of the config: no secret value anywhere, and a
 *  `secretsSet` object saying which ones exist. Used for EVERY channel that carries config
 *  to a window (`config:get`, the `config:changed` broadcast, the trigger lists). */
export function publicConfig<T extends object>(stored: T, vault: SecretVault): T & { secretsSet: SecretsSet } {
  const set = secretsSet(stored as Rec, vault);
  const view = stripSecrets(stored) as Rec;
  if (Array.isArray(view.webhookTriggers)) {
    view.webhookTriggers = view.webhookTriggers.map((t) => (isRec(t) && typeof t.id === 'string' ? { ...t, hasSecret: set.webhooks[t.id] === true } : t));
  }
  return { ...(view as T), secretsSet: set };
}

/** The webhook list as the renderer may see it: no secret, a `hasSecret` flag. */
export function publicWebhooks<T extends { id: string }>(list: readonly T[], stored: Rec, vault: SecretVault): Array<Omit<T, 'secret'> & { hasSecret: boolean }> {
  return list.map((t) => {
    const { secret: _secret, ...rest } = t as T & { secret?: unknown };
    void _secret;
    return { ...(rest as Omit<T, 'secret'>), hasSecret: hasWebhookSecret(t.id, stored, vault) };
  });
}

export interface MigrationResult {
  /** refs now safely in the vault */
  moved: string[];
  /** refs that could not be stored or did not read back: their plaintext is KEPT */
  failed: string[];
  /** The secret-bearing keys to write back (plaintext removed for everything that moved);
   *  empty when nothing needed to move. */
  patch: Rec;
}

/**
 * Move any plaintext secret in the stored config into the vault, WRITE-THEN-VERIFY: the
 * plaintext is dropped from the patch only for a secret whose vault copy reads back
 * exactly. One that cannot be stored (no OS encryption, a locked Keychain) keeps its
 * plaintext, so nothing is lost, and is reported in `failed`.
 */
export function migrateSecretsToVault(stored: Rec, vault: SecretVault): MigrationResult {
  const found = legacyPlaintext(stored);
  const moved: string[] = [];
  const failed: string[] = [];
  if (found.length === 0) return { moved, failed, patch: {} };
  for (const { ref, value } of found) {
    if (vault.get(ref) === value) { moved.push(ref); continue; }
    if (vault.has(ref)) { moved.push(ref); continue; } // the vault already holds its own newer value
    const r = vault.available() ? vault.set(ref, value) : { ok: false };
    if (r.ok && vault.get(ref) === value) moved.push(ref); else failed.push(ref);
  }
  const done = new Set(moved);
  const patch: Rec = {};
  const fine = (ref: string): boolean => done.has(ref) || !found.some((m) => m.ref === ref);
  if (found.some((m) => m.ref === configSecretRef('slackSigningSecret')) && fine(configSecretRef('slackSigningSecret'))) patch.slackSigningSecret = undefined;
  if (found.some((m) => m.ref === configSecretRef('slackBotToken')) && fine(configSecretRef('slackBotToken'))) patch.slackBotToken = undefined;
  if (found.some((m) => m.ref === configSecretRef('groqApiKey')) && fine(configSecretRef('groqApiKey'))) patch.groqApiKey = undefined;
  if (text(stored.webhookSecret) && fine(webhookSecretRef('legacy'))) patch.webhookSecret = undefined;
  if (isRec(stored.orgTrigger) && text(stored.orgTrigger.apiKey) && fine(configSecretRef('orgKey'))) {
    patch.orgTrigger = { ...stored.orgTrigger, apiKey: '' };
  }
  if (Array.isArray(stored.webhookTriggers) && stored.webhookTriggers.some((t) => isRec(t) && text(t.secret))) {
    let stripped = false;
    const list = stored.webhookTriggers.map((t) => {
      if (!isRec(t) || !text(t.secret) || typeof t.id !== 'string' || !fine(webhookSecretRef(t.id))) return t;
      const { secret: _secret, ...rest } = t;
      void _secret;
      stripped = true;
      return rest;
    });
    // an unchanged list is not part of the patch: "nothing could be saved" must change nothing
    if (stripped) patch.webhookTriggers = list;
  }
  return { moved, failed, patch };
}

/**
 * What a general config update coming from the renderer may not write: the secret keys
 * above, and the two trigger structures that carry one (`webhookTriggers`, `orgTrigger`).
 * Those change only through their own handlers (`webhooks:*`, `org:*`, `slack:setConfig`,
 * `freeflow:setConfig`), which route the secret to the vault. Dropping the structures
 * whole, rather than blanking the secret inside them, also means a stale copy can never
 * overwrite the stored list. Pure; returns a copy.
 */
export function withoutSecretKeys<T extends object>(patch: T): T {
  if (!patch || typeof patch !== 'object') return patch;
  const copy: Rec = { ...(patch as Rec) };
  for (const k of SECRET_CONFIG_KEYS) delete copy[k];
  delete copy.webhookTriggers;
  delete copy.orgTrigger;
  return copy as T;
}
