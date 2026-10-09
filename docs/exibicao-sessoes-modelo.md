# Telas de exibição (TV e tablet) — modelo de dados, ameaças e contratos

**Status:** Checkpoint 5B — modelagem e especificação. Nada disto está ligado em produção.

| Peça | Arquivo | Situação |
|---|---|---|
| Migration | `database/migrations/110_exibicao_dispositivos.sql` (+ `110_rollback.sql`) | preparada, **não aplicada** |
| Contrato de segurança (funções puras) | `backend/src/modules/exibicao/exibicao.seguranca.js` | não ligado a rota nenhuma |
| Testes | `backend/test/exibicao-migration-110-pg.test.js` (Postgres real descartável), `backend/test/exibicao-seguranca.test.js` | — |

## 1. Objetivo e princípios

Uma TV ou um tablet compartilhado mostra o Checklist Operacional de **uma** unidade, **só leitura**, sem login
administrativo no aparelho. O gerente autoriza a tela pela Central (no celular ou computador dele), por código
ou QR Code.

1. **Credencial de aparelho, separada da Central.** Não é conta do Supabase nem Context Token. Não autentica
   nenhuma outra rota.
2. **Presa à unidade.** Empresa e unidade são gravadas na aprovação, a partir do contexto de quem aprova.
   Nunca mudam: trocar de unidade = autorizar outra tela.
3. **Sem segredo em claro no banco, em URL, em `localStorage` ou em log.**
4. **Fail-closed.** Qualquer dúvida (revogada, vencida, unidade inativa ou transferida, empresa bloqueada,
   módulo retirado, banco fora) = nenhum dado.
5. **O banco impõe as regras.** As tabelas são fechadas para todos os papéis. Tudo passa por funções
   `SECURITY DEFINER` com `search_path` fixo, executáveis só pelo `service_role`. É o mesmo padrão das
   migrations 101 e 071.

## 2. Dados

### 2.1 `pareamentos_exibicao` — pedido de uma tela ainda sem credencial

| Coluna | Uso |
|---|---|
| `codigo_hash` | HMAC-SHA-256(pepper do servidor, código normalizado). Único entre pedidos ativos |
| `segredo_hash` | SHA-256 do segredo do pedido (cookie HttpOnly da TV). Único |
| `estado` | `pendente` → `aprovado` → `consumido`; ou `expirado` / `cancelado` |
| `criado_em`, `expira_em` | validade de 60 a 900 s (o banco limita a 15 min) |
| `organizacao_id`, `unidade_id` | **nulos até a aprovação**; depois, imutáveis |
| `aprovado_por_conta_id`, `aprovado_por_perfil_id`, `aprovado_em` | quem aprovou |
| `nome_dispositivo`, `modo_dispositivo` | definidos por quem aprova |
| `consumido_em`, `dispositivo_id` | consumo atômico |
| `navegador_resumo`, `rede_prefixo` | família do navegador e rede /24 (IPv4) ou /48 (IPv6) — nunca o IP completo |

### 2.2 `dispositivos_exibicao` — a tela

| Coluna | Uso |
|---|---|
| `organizacao_id`, `unidade_id` | obrigatórios e **imutáveis** (gatilho) |
| `nome` (1–60), `modo_padrao` (`tv`/`tablet`) | identificação |
| `token_hash`, `token_anterior_hash`, `token_rotacionado_em`, `token_confirmado_em`, `token_anterior_valido_ate` | rotação sem tela órfã (§5) |
| `criado_em`, `ultimo_uso_em`, `expira_em` (≤180 d), `inatividade_dias` (1–90) | validade absoluta e por inatividade |
| `autorizado_por_conta_id`, `autorizado_por_perfil_id` | responsável |
| `navegador_resumo`, `rede_prefixo` | identificação mínima |
| `reuso_contador`, `suspeita_em` | sinal de token anterior reaparecido (§5.3) |
| `revogado_em`, `revogado_por_conta_id`, `motivo_revogacao` | revogação (motivo de uma lista fechada) |

### 2.3 Constraints, índices e regras de isolamento

- **Formato:** todos os hashes são hex de 64 caracteres. Texto em claro é recusado pelo banco.
- **Unicidade:** `token_hash` é único sempre; `token_anterior_hash` é único quando existe.
- **Pedidos:** `codigo_hash` é único entre os pendentes e aprovados; `segredo_hash` é único.
- **Coerência de tenant:** um gatilho confere que a unidade pertence à empresa no insert e no update. Uma tela
  nunca muda de unidade; um pedido aprovado também não.
- **Estados coerentes:** "aprovado/consumido" sempre tem empresa, unidade, quem aprovou, nome e modo; "pendente"
  nunca tem unidade; "consumido" sempre tem tela.
- **Revogação coerente:** `revogado_em` e `motivo_revogacao` andam juntos.
- **Gatilho em `unidades`:** se a unidade mudar de empresa ou for desativada, as telas dela são revogadas
  (`unidade_transferida` / `unidade_desativada`) e os pedidos aprovados são cancelados.
- **Integridade referencial:** empresa, unidade e perfil têm FK. Uma empresa apagada leva junto as telas e os
  pedidos. Uma tela apagada pela limpeza leva junto o pedido que a criou.
- **Índices:** telas ativas por (empresa, unidade); pedidos pendentes por expiração e por rede; tokens.
- **Gestão sempre com escopo:** listar, renomear e revogar exigem empresa **e** unidade e filtram por ambas. Um
  id de outra unidade simplesmente não é encontrado.
- **Saídas sem segredo:** a listagem e o estado do pedido nunca devolvem hash.
- **Limites:**
  - 10 telas ativas por unidade (parâmetro, até 100), serializado por unidade com advisory lock;
  - 20 pedidos pendentes por rede;
  - 2000 pedidos pendentes no total.

## 3. Fluxo

```
TV (sem login)                        Backend                                   Gerente (Central, logado)
GET  /exibicao  ── sem cookie ──▶  POST /api/v1/exibicao/pareamentos
                                    gera código + segredo; grava só hashes
◀── código "7KQ2-M9XD" + QR, cookie HttpOnly do pedido
                                                                            abre o QR (ou digita o código)
                                                                            confere nome/modo, confirma
                                   ◀── POST /api/v1/checklist-operacional/telas/aprovar
                                        empresa/unidade = CONTEXTO do gerente (nunca o corpo)
TV consulta o estado ──────────▶   GET /api/v1/exibicao/pareamentos/estado (cookie do pedido)
                                    aprovado → gera o token da tela, consome o pedido (atômico)
◀── cookie HttpOnly da tela; o do pedido é apagado
TV mostra o Checklist ─────────▶   GET /api/v1/exibicao/resumo (cookie da tela) → mesmo cálculo do resumo atual
```

O **código não é credencial**. Sozinho ele não dá acesso a nada: aprovar exige login, contexto e permissão na
Central; consumir exige o **segredo do pedido**, que só existe no cookie HttpOnly do navegador que pediu. Quem
fotografa o código não consegue "puxar" a tela para o próprio aparelho.

O **QR** abre `https://<central>/#aprovar-tela=7KQ2-M9XD`. O código vai no **fragmento**, que não é enviado ao
servidor, não aparece em log de acesso nem em `Referer`.

## 4. Modelo de ameaças

| Ameaça | Defesa |
|---|---|
| **Roubo do cookie** | HttpOnly (XSS não lê), `Secure`, `SameSite=Strict`, Path restrito à API de exibição. Escopo do dano: leitura do Checklist de **uma** unidade. Rotação diária. Revogação imediata na gestão. Token anterior reaparecido = bloqueado e sinalizado (§5.3) |
| **Reutilização de token** | token anterior só vale até o novo ser usado, mais 2 min. Depois: **bloqueado**, contado e sinalizado como suspeito; **nunca revoga sozinho** — revogação é decisão administrativa (§5.3) |
| **CSRF** | gestão usa Bearer (não cookie): imune. Exibição: `SameSite=Strict`, cabeçalho obrigatório `X-Crescer-Exibicao` (força preflight) e `Origin` obrigatório na lista nos POST. GET nunca muda estado |
| **XSS** | cookies HttpOnly; nenhum segredo no JS. A página de exibição não usa `innerHTML` com dado não escapado (já é a regra do Checklist). CSP report-only hoje; recomendação: enforce na página de exibição |
| **Fixação de sessão** | o token sempre nasce no servidor, no consumo de um pedido aprovado. Cookie duplicado com o mesmo nome é recusado (não "escolhe um"). Prefixo `__Secure-` e sem `Domain` |
| **Aprovação indevida** | exige login, contexto e permissão própria. A unidade vem do contexto. A tela de aprovação mostra quando o pedido foi feito, o navegador e a rede. O nome escolhido aparece na TV após aprovar. Auditoria. A tela pode ser revogada a qualquer momento |
| **Adivinhação de código** | 40 bits (Crockford), válido por 10 min, só aprovável por usuário logado com permissão. Limite de tentativas na API: por conta (ex.: 10 por 15 min) e por IP. Tentativa inválida auditada **sem o código**. Mesmo acertando, o atacante só autoriza uma TV que ele não controla |
| **Dupla aprovação simultânea** | `FOR UPDATE` + estado `pendente`: uma vence, as outras recebem `indisponivel` (testado em paralelo) |
| **Duplo consumo / furar o limite** | `FOR UPDATE` no pedido + advisory lock por unidade (testado em paralelo) |
| **Corrida na rotação** (duas abas, respostas atrasadas) | compare-and-swap: a segunda requisição recebe `conflito` e responde sem `Set-Cookie`; vale o cookie da primeira. Refazer a rotação a partir do token anterior só é permitido se a rotação anterior não "pegou" há mais de 1 h — nunca numa corrida (testado). O anterior continua aceito até o novo ser usado |
| **Revogação durante uma requisição** | a revogação vale a partir da próxima consulta (no máximo 30 s numa TV). Recomendação para o 5C: reconferir a tela depois de montar o resumo e descartar a resposta se ela foi revogada no meio |
| **Banco indisponível** | 503, sem dados e sem apagar o cookie. A TV mantém o último retrato **marcado** e depois **esconde** (§6) |
| **Aparelho perdido ou vendido** | "Desconectar" na gestão (uma ou todas da unidade). Expira sozinho por inatividade (30 d) e validade (90 d). Unidade desativada ou transferida revoga |
| **Vazamento entre empresas** | tenant gravado na tela e imutável; gatilho de coerência; gestão sempre filtrada por empresa **e** unidade; resolução devolve só a unidade da própria tela (testado) |
| **Tela offline com dado antigo** | §6 |
| **Enchimento da tabela de pedidos** | limites por rede e global; limpeza oportunista e por job |
| **Log com segredo** | o log de acesso registra só a URL (sem cabeçalho/cookie); nenhum segredo na URL; auditoria com lista fechada de campos (`detalhesAuditoria`) |

## 5. Expiração, rotação e revogação

### 5.1 Validade

- **Pedido:** 10 min; depois da aprovação a tela tem ao menos 5 min para consumir, sem passar de 15 min desde
  o pedido.
- **Tela:**
  - 90 dias de validade absoluta (o banco aceita até 180);
  - 30 dias de inatividade (o banco aceita de 1 a 90);
  - `ultimo_uso_em` gravado no máximo a cada 5 min.

### 5.2 Rotação diária sem tela órfã

1. A resolução indica `rotacao_devida` depois de 24 h de uso confirmado.
2. O backend gera um token novo e chama `rotacionar(id, token_apresentado, novo_hash)` (compare-and-swap).
   - Se der certo: `Set-Cookie` com o novo; o atual vira "anterior".
   - Se der `conflito`: segue sem trocar.
3. **O anterior vale até o novo ser usado pela primeira vez.** Se o `Set-Cookie` se perder (rede caiu, aba
   fechou), a TV segue com o anterior e a rotação é tentada de novo 1 h depois, substituindo só o novo que
   nunca chegou. Nunca há tela órfã.
4. No primeiro uso do novo, o anterior ganha só **2 min de folga**, para requisições que já estavam em voo.

### 5.3 Token anterior reaparecendo: suspeita, não condenação

O reaparecimento do anterior depois da folga **não comprova roubo**. Causas possíveis:

- restauração de backup ou sincronização do navegador;
- aba antiga reaberta, resposta muito atrasada;
- relógio, proxy ou cache;
- **VPN, rede móvel ou troca de IP** — mudança de rede, sozinha, não prova nada.

Não há como distinguir esses casos de uma cópia do cookie com segurança suficiente, e revogar derrubaria TVs
legítimas. **Política conservadora (sem revogação automática):**

1. **Bloqueia a credencial suspeita:** depois da folga, o token anterior nunca mais autentica. Aquela requisição
   recebe `token_substituido`, sem apagar o cookie.
2. **Sinaliza:** `reuso_contador`, `suspeita_em`, `ultimo_reuso_em`, `ultimo_reuso_rede`; evento
   `exibicao.token_anterior_reapareceu` na auditoria.
3. **Mostra na gestão:** "Atividade suspeita — confira esta tela", com contador, quando e de que rede.
4. **Quem decide é uma pessoa** com `checklist.telas.gerenciar`: revoga e reautoriza a TV legítima em 1 min, se
   for o caso.

A TV legítima, que já usa o token novo, continua funcionando, inclusive ao trocar de rede (testado).

**Limite conhecido:** uma cópia do token **atual** é indistinguível da TV legítima (as duas apresentam o mesmo
token). A defesa contra isso é a rotação diária, o cookie HttpOnly, o escopo mínimo (leitura de uma unidade) e a
revogação.

### 5.4 Revogação

| Origem | Efeito |
|---|---|
| Gestão: uma tela | `manual` |
| Gestão: todas da unidade | `unidade_revogada_em_massa`, e cancela pedidos aprovados |
| Na própria TV: "Desconectar" | `desconectado_no_aparelho` |
| Unidade transferida ou desativada | gatilho |
| Suspeita (token anterior reaparecido) | **não revoga**; sinaliza para a gestão (§5.3) |

Uma tela revogada responde 401 e o cookie é apagado. A TV **apaga os dados da tela** e mostra "Esta tela foi
desconectada. Peça ao gerente para conectá-la de novo." O polling para.

Empresa bloqueada e módulo `ifood` retirado **não revogam**: respondem 403 ("Sem acesso", sem dados) e voltam
sozinhos quando o acesso volta (testado).

## 6. Tela offline com dado antigo

| Tempo sem resposta boa | Comportamento |
|---|---|
| até 90 s | normal; o polling tenta de novo |
| 90 s – 15 min | números visíveis, faixa "Dados desatualizados — sem conexão", relógio da última atualização |
| **> 15 min** | **números ocultos**: "Sem conexão com a Central há mais de 15 minutos." O polling continua; volta sozinho |
| 401 (revogada/expirada) | apaga na hora |
| 403 (sem acesso) | apaga na hora; tenta de novo no ritmo normal |

Por que 15 min: o dado não é sigiloso (tempos de preparo e números de pedido), mas uma tela "congelada" na
parede engana a operação. 15 min cobrem quedas curtas de Wi-Fi sem esconder à toa. Fica em
`POLITICA.offlineOcultarS`.

## 7. Cookies e autenticação

| | Tela | Pedido de pareamento |
|---|---|---|
| Nome (produção) | `__Secure-cko_tela` | `__Secure-cko_par` |
| Flags | `HttpOnly; Secure; SameSite=Strict` | idem |
| Path | `/api/v1/exibicao` | `/api/v1/exibicao/pareamentos` |
| Domain | **ausente** (só o host exato) | ausente |
| Max-Age | validade restante (≤90 d) | 10 min |
| Conteúdo | 32 bytes aleatórios (base64url) | idem |

- **Por que `__Secure-` e não `__Host-`:** `__Host-` exige `Path=/`, e aí o cookie iria em toda requisição da
  Central. Com Path restrito, ele só trafega na API de exibição. A proteção contra cookie injetado por
  subdomínio vem de recusar cookie duplicado.
- **Desenvolvimento local (http):** `cko_tela` / `cko_par`, sem `Secure`.
- **Nunca** em URL, `localStorage`, `sessionStorage`, corpo de resposta ou log.
- **Montagem:** a API de exibição é montada **antes** do `requireAuth` em `app.js`, como o gateway do WhatsApp.
  Ela não lê `Authorization` nem `x-context-token`. As rotas da Central nunca leem o cookie da tela. As duas
  credenciais não se misturam.
- **Supabase:** a TV não tem login do Supabase. No celular do gerente, a aprovação usa o login normal dele, sem
  nada novo. Se alguém abrir a Central na TV, o login funciona como hoje, porque o cookie de exibição não vale
  lá.
- **CSRF:**
  - todas as chamadas da página de exibição levam o cabeçalho `X-Crescer-Exibicao: 1`;
  - os POST com cookie exigem `Origin` presente e na lista (`origemPermitida`);
  - os GET não mudam estado.

## 8. Contratos dos endpoints (futuros — Checkpoint 5C)

Erros seguem o formato atual (`{ error, codigo?, details? }`). Nenhuma resposta contém token, segredo ou hash.

### 8.1 Exibição (cookie da tela ou do pedido; sem login)

| Método e rota | Entrada | Saída | Status |
|---|---|---|---|
| `POST /api/v1/exibicao/pareamentos` | — (Origin + cabeçalho) | `{ codigo: "7KQ2-M9XD", qrUrl, expiraEm }` + cookie do pedido | 201; 429 (limite de rede/global); 503 |
| `GET /api/v1/exibicao/pareamentos/estado` | cookie do pedido | `{ estado: "pendente"\|"aprovado"\|"conectada"\|"expirado"\|"cancelado", expiraEm, unidadeNome?, nomeTela? }`. Em `aprovado`, o servidor consome o pedido, grava o cookie da tela, apaga o do pedido e responde `conectada` | 200; 401 (sem pedido); 409 `limite_atingido`; 503 |
| `DELETE /api/v1/exibicao/pareamentos` | cookie do pedido | — (cancela) | 204 |
| `GET /api/v1/exibicao/sessao` | cookie da tela | `{ tela: { nome, modo }, unidade: { nome }, empresa: { nome } }` | 200; 401 `EXIBICAO_*`; 403 `EXIBICAO_SEM_ACESSO`; 503 |
| `GET /api/v1/exibicao/resumo` | cookie da tela | **o mesmo `data` de `GET /api/v1/checklist-operacional/resumo`**, com o tenant da tela; `tempoReal.habilitado = false` (só polling na fase 1); pode trazer `Set-Cookie` de rotação | 200; 401; 403; 503 |
| `POST /api/v1/exibicao/desconectar` | cookie da tela (Origin) | — (revoga a si mesma e apaga o cookie) | 204 |

### 8.2 Gestão (Central; Bearer + contexto + `requireModulo(ifood)` + permissão `checklist.telas.gerenciar`)

| Método e rota | Entrada | Saída | Status |
|---|---|---|---|
| `POST /api/v1/checklist-operacional/telas/consultar` | `{ codigo }` (no corpo, nunca na URL) | `{ pedidoEm, expiraEm, navegador, rede }` — para o gerente reconhecer a TV antes de aprovar | 200; 404 (resposta genérica); 409 `indisponivel`; 429 |
| `POST /api/v1/checklist-operacional/telas/aprovar` | `{ codigo, nome, modo }` — empresa e unidade vêm do **contexto** | `{ telaPendente: { nome, modo }, unidade }` | 200; 404 (código inexistente ou expirado, resposta genérica); 409 `indisponivel`; 403; 429 |
| `GET /api/v1/checklist-operacional/telas` | — | `{ telas: [{ id, nome, modo, situacao, criadaEm, ultimoUsoEm, expiraEm, inativaEm, navegador, rede, suspeita, revogadaEm, motivo }] }` | 200 |
| `PATCH /api/v1/checklist-operacional/telas/:id` | `{ nome }` | `{ ok: true }` | 200; 404; 422 |
| `POST /api/v1/checklist-operacional/telas/:id/revogar` | — | `{ revogadas: 1 }` | 200; 404 |
| `POST /api/v1/checklist-operacional/telas/revogar-todas` | `{ confirmar: true }` | `{ revogadas: n }` | 200 |

**Limites de taxa** (camada `limiteDeTaxa` existente):

| Rota | Limite |
|---|---|
| `aprovar` | 10 por 15 min por conta, mais um limite por IP |
| `pareamentos` (POST) | 5 por min por IP |
| `estado` | 1 a cada 2 s por pedido |
| `resumo` | 6 por min por tela |

## 9. Permissões

Permissão nova: **`checklist.telas.gerenciar`**. Não é derivada de `integracoes.ver`: o papel `viewer` tem
`integracoes.ver` e **não** deve autorizar TVs.

| Ação | `organization_admin` | `unit_manager` | `finance` / `operations` / `viewer` |
|---|---|---|---|
| Aprovar tela (pareamento) | ✔ | ✔ | — |
| Listar telas | ✔ | ✔ | — |
| Renomear | ✔ | ✔ | — |
| Revogar uma | ✔ | ✔ | — |
| Revogar todas da unidade | ✔ | ✔ | — |

- **SuperAdmin em impersonação:** passa, como em toda a Central. A auditoria registra `impersonado_por`.
- **Escopo:** sempre a unidade do contexto atual. Um `unit_manager` não gerencia telas de outra unidade porque o
  contexto dele é da unidade dele.

## 10. Auditoria

Eventos novos em `plataforma_auditoria`, que é imutável por gatilho:

- `exibicao.pareamento_aprovado`
- `exibicao.pareamento_recusado`
- `exibicao.tela_criada`
- `exibicao.tela_renomeada`
- `exibicao.tela_revogada`
- `exibicao.telas_revogadas_unidade`
- `exibicao.tela_desconectada`
- `exibicao.token_anterior_reapareceu`

`detalhes` passa por `detalhesAuditoria`: lista fechada de campos por evento; descarta qualquer chave proibida
(token, código, segredo, cookie, IP, e-mail…) e qualquer valor com cara de credencial.

**Rotações não são auditadas**, para evitar ruído diário; ficam em `token_rotacionado_em`.

## 11. Pendências e decisões

1. **Pepper do código:** uma variável nova (`EXIBICAO_CODIGO_PEPPER`, ≥32 caracteres) no Render, no 5C. Exige
   autorização.
2. **Permissão nova e papéis:** confirmar `organization_admin` e `unit_manager`.
3. **Valores:** 90 d de validade, 30 d de inatividade, 10 telas por unidade, 15 min para esconder offline.
4. **Aplicar a migration 110** em produção: passo separado, com autorização.
5. **CSP enforce** na página de exibição: recomendado no 5E.
6. **Realtime para as telas:** fase posterior (canal do backend), sem token do Supabase no aparelho.
