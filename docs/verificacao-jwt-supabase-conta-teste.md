# Verificação do JWT real do Supabase com uma CONTA DE TESTE (Checkpoint 6B.4)

**Por que é bloqueio de homologação.** O limite absoluto de 20 h da renovação do perfil de exibição conta desde o
`amr[].timestamp` do JWT. Se o Supabase **reiniciar** esse carimbo a cada refresh do access token, a janela de 20 h seria
renovada pelo refresh e o teto deixaria de valer. A documentação do Supabase descreve o formato (lista de `{method, timestamp}`,
em segundos), mas **isso não substitui a comprovação** com um token real — e ela **ainda não foi feita** (não há conta de teste autorizada
nesta máquina). Até lá, a renovação de 20 h **não está aprovada**; sem carimbo o sistema cai em 8 h (seguro).

## Regras
* Use **somente uma conta de TESTE** criada para isso (e-mail descartável, **fora** de qualquer loja real, **sem** papel administrativo),
  de preferência num projeto/ambiente de **teste** do Supabase. **Nunca** conta de loja real, SuperAdmin ou chave de serviço.
* Nada de token em chat, relatório, commit, ticket ou arquivo. O script lê o token **só pela entrada padrão** e imprime **apenas**:
  nomes das claims, formato do `amr` (e os métodos, ex. `password`), idades em minutos, o **instante UTC do carimbo** e se `session_id` existe.
  **Não imprime nem grava** o token, o `sub`, o e-mail nem qualquer valor de claim. Não usa rede. Não carrega `.env`.
* Não use `--env-file`. Não cole o token em lugar nenhum além do pipe abaixo.

## Procedimento (≈ 70 min)
1. Entre na Central com a **conta de teste**, num perfil de navegador limpo.
2. No console do navegador (`F12`), copie o token **sem imprimi-lo** (o `copy()` não mostra o valor):
   ```js
   copy(JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => /^sb-.*-auth-token$/.test(k)))).access_token)
   ```
3. No terminal, em `backend/`: `Get-Clipboard | node scripts/verificar-jwt-amr.mjs` (PowerShell). Anote **só**:
   o horário local, o "carimbo de autenticação (UTC)" e o "autenticado há".
   **Esperado:** `amr: objetos {method, timestamp}`, `RESULTADO: carimbo OK`, "autenticado há" ≈ poucos minutos.
4. **Deixe a aba aberta.** O access token do Supabase dura ~1 h e a Central o renova sozinha (`autoRefreshToken`).
   Espere **≥ 65 min** (ou, no projeto de teste, reduza a validade do JWT em *Auth → Settings* para 5 min e espere 10; é configuração do ambiente
   de **teste**, nunca da produção).
5. Confirme que houve refresh: o campo `iat` ("emitido há") do novo token é recente (poucos minutos) — copie o token de novo (passo 2) e rode o script outra vez.
6. **Comparação automática (recomendada):** rode o script do passo 5 já com os dois valores anotados no passo 3 (o "carimbo de autenticação (UTC)" e o "iat (emissão) deste token (UTC)" — o script imprime esse `iat` na comparação; na 1ª execução anote o "emitido há" convertido em horário UTC, ou rode a 1ª também com `--carimbo-esperado=<qualquer>` para ver o `iat`):
   `Get-Clipboard | node scripts/verificar-jwt-amr.mjs --carimbo-esperado=<UTC do passo 3> --iat-anterior=<UTC do iat do passo 3>`
   → imprime **ESTÁVEL** (exit 0) ou **INSTÁVEL** (exit 1); se o `iat` não avançou, avisa que o teste não prova nada.
   Envie ao responsável técnico **somente as linhas impressas** pelo script (nunca o token, o e-mail ou capturas do `localStorage`).
   **Critério de aprovação:** o **"carimbo de autenticação (UTC)" é EXATAMENTE o mesmo** do passo 3 (o "autenticado há" cresceu o tempo decorrido),
   enquanto o `iat`/`exp` mudaram. Isso prova que o carimbo é a **origem estável** do login, não do refresh.
7. Repita saindo e entrando de novo (login novo): o carimbo deve **avançar** para o novo login. Isso confirma que "sair e entrar" renova o limite.
8. (Opcional, com MFA de teste) cadastre um TOTP, valide-o e rode o script: `aal2`, `amr` com `password` e `totp`, e o carimbo mais recente passa a ser o do TOTP — o
   código usa o **mais recente**, então um passo de MFA conta como autenticação.

## Critérios OBJETIVOS para classificar a sessão de 20 h

Execute a rodada completa (passos 1–7) **duas vezes de refresh** (dois refreshes consecutivos, ≥ 55 min entre cada coleta, ou 2 coletas com `exp` reduzido no projeto de TESTE).
Registre, para cada coleta, **somente**: horário local, "carimbo de autenticação (UTC)", "iat (emissão) UTC", o veredito `ESTÁVEL/INSTÁVEL` e o código de saída do script.

| # | Critério (mensurável) | Como medir | Passa quando |
|---|---|---|---|
| A | **Formato**: `amr` é lista de **objetos** `{method, timestamp}` com `timestamp` numérico (segundos) | saída: `amr: objetos {method, timestamp}` e `RESULTADO: carimbo OK` (exit 0) na 1ª coleta | sim, em **todas** as coletas |
| B | **Estabilidade no refresh** | 2ª e 3ª coletas com `--carimbo-esperado=<UTC da 1ª>` e `--iat-anterior=<iat da coleta anterior>` | **ESTÁVEL** (exit 0) **nas duas**, com `houve refresh (iat avançou)` — carimbo igual (tolerância 1 s) |
| C | **Novo login avança o carimbo** | passo 7: sair/entrar de novo e coletar | o carimbo novo é **posterior** ao anterior em ≥ o tempo decorrido entre os logins (e `ESTÁVEL` contra o novo valor nas coletas seguintes) |
| D | **Origem confiável**: o carimbo vem do `amr` do token **validado** pelo Supabase | já garantido no código (`getUser` valida o token antes de qualquer claim ser lida) — nada a medir | (código) |
| E | **Teto efetivo ponta a ponta (recomendado)**: no projeto de TESTE, backend local/teste com `RENOVACAO_EXIBICAO_LIMITE_S=600` (10 min; mínimo permitido) e validade do JWT do projeto de teste em 5 min | logar com a conta de exibição de teste; deixar o refresh acontecer; depois de 10 min do login, `POST /api/v1/sessao/renovar` | resposta **`401` com `details.codigo = REAUTENTICACAO_NECESSARIA`**, **mesmo com refresh feito no intervalo** — e a TV de teste cai no login |

**Classificação (regra única, sem exceções):**
* **APROVADA (20 h valem)**: A, B e C passam **e** E passa. Autoriza o piloto de 17 h.
* **APROVADA COM RESSALVA (somente homologação)**: A, B e C passam, E **não executado**. Pode seguir para o piloto **assistido**, com acompanhamento no horário do limite; **não** vai a produção sem E.
* **NÃO APROVADA**: **qualquer** destes — `amr` ausente/só strings/sem `timestamp` (A falha); **INSTÁVEL** em qualquer coleta (B falha: o refresh reinicia o carimbo ⇒ renovação infinita); carimbo **não** avança num login novo (C falha); E retorna 200/201 depois do limite. Nesse caso a renovação de 20 h **não pode** ser publicada; vale **8 h** (padrão seguro, sem carimbo o sistema já cai nisso) até haver alternativa **aprovada** (ancorar no `session_id`, time-box do Supabase ou 8 h) — nenhuma é implementada sem autorização.
* **INCONCLUSIVA**: o `iat` **não avançou** entre coletas (o script avisa), ou só houve **uma** coleta/refresh, ou o script falhou por entrada inválida. **Repetir** — conta como **NÃO APROVADA** até ser concluída.

> Segurança da execução: o token só passa pelo *pipe* para o script; ninguém cola token em chat/relatório. O responsável técnico recebe **apenas** as linhas impressas.

## Efetividade do teto — apoio
Já provada no código por simulação (`renovacao-exibicao-expediente-abas-real-pg.test.js`): contexto encurtado até o limite; depois dele,
renovar e reentrar são recusados (`REAUTENTICACAO_NECESSARIA`) até haver login novo. No piloto, confirme na loja de teste que, 20 h
depois do login, a TV mostra a tela de login.
