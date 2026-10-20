// Stub mínimo do supabase-js para o QA visual (sem rede). Sessão sempre "logada" com um token fictício.
(function () {
  const sessao = { access_token: "qa.token.ficticio", user: { id: "u-qa", email: "qa@exemplo.invalid", factors: [] } };
  const vazio = async () => ({ data: null, error: null });
  const canal = () => { const c = { on: () => c, subscribe: () => c, unsubscribe: async () => "ok", send: vazio }; return c; };
  const auth = {
    getSession: async () => ({ data: { session: sessao }, error: null }),
    getUser: async () => ({ data: { user: sessao.user }, error: null }),
    signInWithPassword: async () => ({ data: { session: sessao, user: sessao.user }, error: null }),
    signOut: async () => ({ error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    mfa: { listFactors: async () => ({ data: { totp: [], all: [] }, error: null }), getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal1", nextLevel: "aal1" }, error: null }) },
    refreshSession: async () => ({ data: { session: sessao }, error: null }),
    setSession: async () => ({ data: { session: sessao }, error: null }),
  };
  window.supabase = { createClient: () => ({ auth, channel: canal, removeChannel: vazio, realtime: { setAuth() {} }, from: () => ({ select: vazio }) }) };
})();
