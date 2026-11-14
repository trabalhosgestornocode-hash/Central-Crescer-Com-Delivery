# Financeiro v2 — 23. Identidade individual, MFA, infraestrutura de homologação e liberação controlada (Execução 09B)

Data: 14/11/2026. Branch local `feat/financeiro-v2-identidade-homologacao`, derivada de `195eee1` (09).

> **Decisões técnicas e preparação LOCAL. Nenhuma infraestrutura remota foi provisionada; nenhuma integração real.**
> - Produção não acessada; `backend/.env` não lido (testes com `node --test` direto); Supabase não consultado; nenhuma
>   autenticação, permissão ou dado real alterado ou usado; sem push/merge/deploy; nenhuma rota publicada; nenhuma
>   unidade liberada.
> - Tokens, segredos, identidades e organizações dos testes são **sintéticos** (o segredo de teste não é de projeto algum).
> - Migrações 0001–0021 só no PostgreSQL local isolado.

Matriz para decisão: [23a-matriz-pendencias-aprovacao.md](23a-matriz-pendencias-aprovacao.md).

---

## 1. Diagnóstico da identidade atual (Fase A)

| Item | Como é | Verificável no backend? | Evidência |
|---|---|---|---|
| Conta autenticada | Usuário do Supabase Auth; `requireAuth` valida o JWT com `supabase.auth.getUser` a cada requisição e relê `perfis`, SuperAdmin e Painel | **Sim** | `middlewares/auth.js` L99–164 |
| Pessoa operacional | `perfis_operacionais` (N por conta); a sessão de contexto guarda `perfil_id`; `requireContexto` confere `pid` do token × linha × perfil ativo | **Sim** (relido a cada requisição) | `auth.js` L222–243; `contextToken.js` |
| PIN | 4–6 dígitos, scrypt, bloqueio 5 tentativas/15 min no servidor; prova de seleção HMAC de 5 min, vinculada a conta+pessoa, **uso único só com a migração 064** | Sim, mas **definido/redefinido pelo SuperAdmin** | `docs/multi-perfil-fase-h-pin.md` §§ B–H, P |
| Troca de pessoa | Nova seleção (PIN) + nova sessão de contexto | Sim | idem § F |
| Troca de empresa/unidade | `trocar-unidade` cria sessão nova e revoga a anterior | Sim | `sessao.service.js` |
| Expiração/revogação | Contexto 8 h (suporte 1 h), relido a cada requisição; logout revoga a linha; PIN redefinido revoga sessões da pessoa | Sim | `auth.js`; doc multi-perfil § H |
| Contas compartilhadas | Previstas (uma conta de loja, várias pessoas por PIN); com 1 pessoa ativa o PIN não é pedido | Sim (contagem de pessoas ativas) | doc multi-perfil § C, G |
| Recuperação de acesso | Senha: Supabase Auth (fluxo do provedor) + troca obrigatória de senha provisória; PIN: reset pelo SuperAdmin | Parcial (o fluxo de e-mail é do provedor) | `exigirSenhaDefinitiva`; doc multi-perfil § H |
| Impersonação de suporte | SuperAdmin entra como empresa (sem pessoa operacional), 1 h, **passa por qualquer permissão/módulo/papel** da plataforma | Sim (`impersonado_por` na linha) | `auth.js` L422–497 |
| Papéis administrativos | Vínculo por pessoa (`organization_admin`, `unit_manager`, `finance`, …) + globais (SuperAdmin, Painel) | Sim | `shared/permissoes.js` |
| Auditoria da plataforma | `auditar()` com ator (conta), tipo, pessoa, `impersonado_por`; nunca grava PIN/hash | Sim | `sessao.service.js`; doc multi-perfil § I |

**O que depende só da interface:** a tela de escolha de pessoa e o desafio de MFA são executados no navegador; o backend
só confia no resultado assinado (prova de seleção; JWT em `aal2`). Nenhuma decisão de acesso vem de campo declarado.

### Regra financeira (decisão técnica desta execução)

1. **Ator financeiro = pessoa operacional de uma CONTA PESSOAL** (exatamente uma pessoa ativa). Conta compartilhada não
   opera o v2 (nem lê): o login e o segundo fator provam a conta, não a pessoa.
2. **PIN não é MFA nem prova de identidade individual** para o financeiro: é conhecido/definido pelo administrador,
   curto, e serve para separar pessoas numa conta compartilhada — justamente o caso recusado.
3. Pessoa cadastrada não ganha nada: só concessão explícita `financeiro_v2.*`.
4. Nenhuma tela de login financeira. Se no futuro for preciso confirmar a pessoa numa ação sensível, o fluxo é o
   **desafio de MFA da própria plataforma** (TOTP do Supabase) disparado pela ação ("confirme com seu autenticador"),
   na mesma sessão — não ativado para usuários reais. Impacto: um código de 6 dígitos a cada 10 min só nas ações
   sensíveis; dependência: MFA cadastrado por quem opera essas ações.

## 2. Contrato da pessoa operacional

O adaptador (`integracao/plataforma.js`) recusa, em ordem: sessão ausente/expirada, conta inativa, senha provisória,
impersonação, perfil de exibição, sem pessoa, "todas as unidades", contexto divergente, empresa/unidade não liberada,
**conta compartilhada**, **pessoa inativa ou de outra conta** (porta `vinculos.contaDoPerfil`, motivo
`PESSOA_SEM_IDENTIDADE`), unidade fora dos vínculos, sem concessão. A identidade registrada em cada operação é
`{ perfilId, contaId }` + origem (`sessaoId` da plataforma).

## 3. Política de contas compartilhadas

**Recomendação: manter recusadas** no Financeiro v2 (padrão do código: `permitirContaCompartilhada: false`). Quem opera o
financeiro usa conta pessoal com MFA. Alternativas avaliadas e **não** recomendadas: aceitar PIN como identidade
(conhecido pelo SuperAdmin); exigir MFA da conta compartilhada (o fator é da conta, não da pessoa). Decisão final é da
empresa (doc 23a, decisões de política).

## 4. Evidência de MFA (Fase B)

**Previsto e implementado:** TOTP do Supabase (cadastro `mfa.enroll` + `challenge` + `verify`, desafio no login,
remoção pelo próprio usuário), sessão sobe para `aal2`; o backend lê `aal`/`amr` do JWT **depois** de `getUser` validar
o token; exigência por papel existe mas está **dormente** (`MFA_ENFORCE_*`); auditoria dos eventos de MFA a partir do
estado relido (`/sessao/mfa/evento`). **Não implementado:** WebAuthn, SMS, MFA por pessoa operacional, exigência ativa.

**Limitações comprovadas (código local):**
- O fator pertence à **conta** (usuário do Supabase), não à pessoa operacional → conta compartilhada nunca prova a pessoa.
- `req.user.aal`/`mfaEm` são derivados do JWT validado — confiáveis **dentro do backend da plataforma**, mas o v2 da 09
  os recebia prontos. A 09B deixa de confiar neles para autorizar.
- A unidade do `amr[].timestamp` (segundos, pela especificação do provedor) **não foi confirmada contra um token real**
  (nota do próprio código em `shared/mfaRecente.js`). Até confirmar, a prova não pode ser liberada em ambiente real.
- Não se sabe, pelo código, se o `access token` continua aceito até expirar depois de `signOut` local.

**Contrato implementado (`integracao/provaDeAutenticacao.js`):** para conceder, revogar, homologar, reabrir,
provisionar e alterar liberação, o v2 exige a **prova derivada do token de acesso**, verificada por uma porta de
assinatura no servidor:
1. assinatura válida do provedor (algoritmo fixo; `alg: none` e trocas recusadas);
2. `exp` no futuro; `iat` não no futuro;
3. `sub` = conta da sessão (fator de **outra** conta é recusado);
4. `aal = aal2`;
5. `amr` com método de segundo fator (TOTP/WebAuthn/telefone) com carimbo numérico **em segundos**, ≤ `iat` e ≤ agora,
   no máximo **10 minutos** atrás. Senha, OTP por e-mail/link e PIN não contam. Carimbo em milissegundos é recusado
   (nada é "adivinhado").
Sem porta configurada → `MFA_INDISPONIVEL` (ação bloqueada). Testes: ausência, expiração, falsificação (assinatura,
`alg: none`, payload adulterado, carimbo incoerente, token do futuro), troca de identidade e aal declarado sem token.

**Para usar em ambiente real (dependência):** implementar a porta com a chave de assinatura real do provedor (JWKS
assimétrico) ou validação no próprio provedor, no gateway — nunca com segredo exposto ao serviço comum — e confirmar a
unidade do carimbo com um token real num projeto descartável.

## 5. Gateway (Fase D)

Contrato puro em `integracao/politicaDoGateway.js` (`decidirEmissao`, `eventoSemSegredos`), testado:

| Requisito | Como |
|---|---|
| Receber identidade autenticada | A sessão da plataforma (verificada no backend) chega por canal autenticado serviço→gateway; o gateway REVALIDA o token de acesso no provedor |
| Validar escopo | Uma organização e uma unidade, as da sessão; o pedido não pode trazer organização, ações, usuário nem validade (`PEDIDO_TENTA_DEFINIR_ESCOPO`); unidade diferente da sessão é recusada |
| Comprovar MFA | Finalidades `ACAO_SENSIVEL`, `PROVISIONAMENTO`, `LIBERACAO` exigem prova verificada da **mesma** conta |
| Emitir | `fv2_abrir_sessao` (token opaco, só hash no banco) com as ações da concessão **vigente lida pelo gateway** |
| Credencial de autoridade | Só no gateway (papel `fv2_autoridade`); o serviço comum tem `fv2_app` (teste "13" da 09: o serviço só lê `aplicacao.json`) |
| Revogar | `fv2_encerrar_sessoes` em logout, troca de unidade, revogação de concessão, desligamento da liberação |
| Expirar | ≤ 15 min (≤ 5 min sensível) e nunca além da sessão da plataforma; < 30 s restantes → não emite |
| Registrar | Eventos com `eventoSemSegredos` (remove campos/valores de token, senha, segredo, PIN, cabeçalho de autorização) |
| Impedir impersonação | Mesmas recusas do adaptador (sem bypass de suporte) |
| Impedir escalada | Ações vêm da concessão no banco; o banco confere de novo (0011–0013); conceder/revogar com regras próprias |
| Evitar vazamento | Token nunca em log, URL ou corpo de resposta além do necessário; só hash persistido |
| Rotacionar | Credencial `fv2_autoridade` e chave do canal serviço→gateway com rotação programada e de emergência |

## 6. Infraestrutura de homologação (Fase C)

Três ambientes distintos: **(1) homologação local** (existe: PG 17 descartável + gateway sintético + cofre em disco,
127.0.0.1); **(2) homologação remota isolada** (não existe; desenhada abaixo); **(3) produção** (não existe para o v2).

Hipóteses de dimensionamento (explícitas, a confirmar): até 10 unidades na homologação; ~400 vendas/mês/unidade (volume
do gerador sintético); ~200 documentos/mês/unidade de ~300 KB; 5–20 usuários simultâneos.

| Componente | Função | Requisitos | Recursos estimados (hipótese) | Credenciais | Isolamento | Recuperação | Riscos |
|---|---|---|---|---|---|---|---|
| PostgreSQL dedicado | Dados do v2 | PG ≥ 15 (testado em 17), papéis `fv2_dono/app/autoridade/guardiao`, RLS, funções `security definer`, `pg_current_xact_id` | 1–2 vCPU, 2–4 GB RAM, 10–20 GB (dados < 1 GB/ano na hipótese) | Dono (só migração), app, autoridade | Instância/projeto separado do Supabase da plataforma; rede privada; sem superusuário para a aplicação | PITR + dump diário; restauração ensaiada (08) | Provedor sem papéis customizados ou sem `security definer` sob controle |
| Aplicação v2 | Rotas do v2 atrás de `requireAuth`/`requireContexto` | Node 20, mesmo backend da plataforma (rotas atrás de liberação) | Sem recurso extra relevante | `fv2_app` | Nunca vê credencial de autoridade nem chave de assinatura | Sem estado (sessões no banco) | Misturar segredos com o backend comum |
| Gateway de autoridade | Emitir/encerrar sessões de banco, alterar liberação, provisionamento | Processo separado, canal autenticado, revalida token no provedor | 0,25–0,5 vCPU, 256–512 MB | `fv2_autoridade`, chave do canal, chave de verificação de token | Serviço/rede próprios, segredos próprios | Sem estado; indisponível = financeiro fechado | Ponto único; precisa de monitoramento |
| Cofre documental | Arquivos de evidência | Armazenamento de objetos privado, criptografia em repouso, hash conferido | ~60 MB/mês/unidade (hipótese) | Chave de escrita só no serviço; leitura por URL assinada curta ou pelo serviço | Bucket dedicado, sem acesso público | Versionamento + backup sincronizado com o banco | Inconsistência banco×cofre (protocolo em duas fases da 08D) |
| Antimalware | Varredura de envios antes de liberar | Fila de quarentena; motor de varredura | Pequeno; depende da solução | Própria | Isolado do cofre principal | Arquivo fica em quarentena | **Não existe hoje** |
| Autenticação | Plataforma (Supabase Auth) | MFA TOTP ativo para quem opera ações sensíveis | — | Chave de verificação do token (JWKS) | Só leitura de chave pública | Provedor | MFA dormente hoje |
| Auditoria | Histórico do v2 + eventos do gateway | Retenção definida, imutável | Pequeno | — | Sem segredos (testado) | Backup | Política de retenção indefinida |
| Backup/restauração | PITR + dumps + cofre | Ensaios periódicos | Conforme provedor | Separadas | Cópia fora do provedor principal | Procedimento escrito | Restauração nunca ensaiada no remoto |
| Monitoramento | Gateway, banco, erros FV0xx, tempos | Alertas | Pequeno | — | — | — | Sem alerta = falha silenciosa |
| Estatísticas PG | `ANALYZE` após carga | Autovacuum + rotina pós-importação | — | Dono | — | — | Planos ruins sem estatística (08C/08D) |

**Custos:** não estimados em valor — o repositório não tem cotações, e preços mudam. Itens a cotar: instância PG
gerenciada com PITR, um serviço pequeno sempre ligado (gateway), armazenamento de objetos + transferência, solução
antimalware, monitoramento.

## 7. Alternativas técnicas (sem contratar nada)

| Alternativa | Prós | Contras / evidência faltante |
|---|---|---|
| **A. Projeto Supabase SEPARADO só para o v2** (PG + Storage) + gateway em serviço separado | Mesmo provedor da plataforma; PG gerenciado com backup; Storage privado | Precisa confirmar: papéis customizados sem `bypassrls`, propriedade de funções pelo guardião, `pg_current_xact_id`, conexões diretas do gateway. **Não** usar o projeto atual da plataforma |
| **B. PostgreSQL gerenciado genérico** (qualquer provedor com PG ≥ 15 e papéis próprios) + armazenamento de objetos + gateway | Controle total de papéis/RLS | Mais peças para operar |
| **C. Render** para aplicação e gateway | Já usado pela plataforma | O repositório só declara **um serviço web `plan: free`** (`render.yaml`): sem evidência de serviço privado, disco persistente ou rede interna nos planos usados. Plano gratuito hiberna → inadequado para o gateway |
| D. Tudo no backend atual | Menos peças | **Recusada**: a credencial de autoridade ficaria no mesmo processo/ambiente de segredos do serviço comum |

Recomendação técnica: **A ou B** para dados e cofre, gateway como serviço **separado e sempre ligado**; decidir após
validar os pontos marcados em A.

## 8. Liberação por unidade (Fase E)

Implementada: memória (`integracao/liberacoes.js`) e PostgreSQL (**migração 0021**, `infra/postgres/liberacoesPostgres.js`).
- **Desligada por padrão** (sem linha = desligada); unidade só vale com a empresa ligada.
- A aplicação só **lê** (`fv2_liberacao_estado`); **só a autoridade** altera (`fv2_liberacao_alterar`), com ator,
  justificativa ≥ 20 e carimbo de segundo fator recente (conferido contra o relógio do banco); histórico **imutável**
  (nem o dono altera); unidade fora dos escopos do banco é recusada. Tabelas guardadas: a aplicação não tem privilégio.
- Liberar não concede nada; desligar não apaga dados nem concessões; vale na operação seguinte.
- Rota direta: toda chamada do v2 passa pelo adaptador, que confere liberação, pessoa e concessão a cada operação —
  uma URL direta numa unidade não liberada não abre nada.
- No menu, `liberado: false` mantém o financeiro atual; `liberado: true` sem pessoa/concessão = negado (encaixe da 09).

## 9. Matriz financeira pendente (Fase F)

[23a](23a-matriz-pendencias-aprovacao.md): versão para aprovação com os 24 tipos e 7 impedimentos (classificação e
vínculo com o código preservados), responsável, justificativa, testes e campo de decisão **em branco**. Nenhuma regra de
fechamento alterada na 09B. **NÃO aprovada pela empresa.** Itens marcados **RF** dependem do responsável financeiro.

## 10. Acessibilidade (Fase G)

| Verificação | Resultado |
|---|---|
| Contraste AA (tokens reais, claro/escuro) | PASS (teste `financeiroV2Contraste`) |
| Teclado no navegador real (Tab → Enter → Escape, foco volta à origem) | PASS (rodado de novo nesta execução) |
| 390 px sem rolagem horizontal (fechamento, conta, contas de novembro) | PASS (rodado de novo) |
| Auditor automático dos painéis | PASS (suíte do frontend) |
| **Leitor de tela real** | **NÃO TESTADO** — NVDA não instalado; Narrador sem captura verificável. Roteiro humano: doc 22 § 9 |
| Indicador de foco visível, hover, gráficos | **NÃO TESTADO** |

## 11. Desempenho (Fase G)

Medição com o gerador da 08D (`node scripts/fv2-desempenho.mjs <meses> 200`, PostgreSQL isolado, dados sintéticos, este
computador — observações, não metas). Histórico de 3 → 6 → 12 meses (600 → 1.200 → 2.400 vendas; 810 → 3.240 lançamentos):

| Tela | 3 m (ms) | 6 m | 12 m | 12 m ÷ 3 m |
|---|---|---|---|---|
| **Contas a receber (página)** | 30 | 65 | 164 | **5,47×** |
| **Caixa e bancos (mês)** | 32 | 64 | 150 | **4,69×** |
| **Visão Geral** | 63 | 112 | 215 | **3,41×** |
| Contas a pagar (página) | 12 | 17 | 40 | 3,33× |
| Apuração / DRE (mês) | 26 | 34 | 42 | 1,62× |
| Central de Conferências | 103 | 133 | 190 | 1,84× |
| Fechamento (situação) | 122 | 152 | 188 | 1,54× |
| 10 telas simultâneas | 385 | 498 | 707 | 1,84× |

Linhas e consultas lidas pela carga dirigida (3 m → 12 m): Visão Geral e Caixa 1.410 → 5.637 linhas (19 → 24 consultas);
Contas a Receber 1.012 → 4.195 linhas e **18 → 40 consultas**. Equivalência dirigida × completa: idêntica nos 12 meses.

**Diagnóstico:** as telas de posição leem o histórico inteiro (saldo e posição dependem de todo o passado). Contas a
Receber cresce mais que os dados (5,5× para 4×): além das linhas, o número de consultas sobe com a carga em lotes de 200.

**Recomendações para volume real (não implementadas — sem refatoração ampla nesta execução):**
1. **Âncoras de saldo por conta e mês**, gravadas no fechamento homologado, para Caixa/Visão Geral começarem da última
   âncora conferida (sem mudar fórmula: a âncora é o mesmo saldo calculado, congelado e auditável).
2. **Contas a Receber filtrando no banco** só títulos em aberto e as liquidações deles (índice parcial por situação),
   em vez de carregar todos os recebíveis e liquidações em lotes.
3. Paginação da carga em lotes maiores ou por chave composta para reduzir idas ao banco.
4. Repetir a medição com volume real anonimizado antes de decidir (as hipóteses sintéticas podem não representar a operação).

## 12. Testes

| Suíte | `195eee1` (09) | Final 09B |
|---|---|---|
| Núcleo em memória | 367/367 | **380/380** |
| Núcleo em PostgreSQL isolado | 367/367 | **380/380** (suíte completa; os dois arquivos alterados depois foram repetidos no banco: 24/24) |
| Só em memória, sem banco (condição equivalente; `195eee1` num worktree temporário) | 307 aprovados, 60 pulados, 0 falhas | **319 aprovados, 61 pulados, 0 falhas** |
| Frontend | 1956/0/26 | **1956 aprovados, 0 falhas, 26 pulados** |
| Navegador real (teclado e 390 px) | PASS (09) | **PASS** (repetido) |
| Mutação das regras da 09B | — | **17/17 detectados** |

Comparação por nome: os 367 testes de `195eee1` continuam presentes e nenhum passou a falhar ou a ser pulado. Testes
antigos **ajustados** (sem afrouxar): o "10" da 09 (MFA agora exige token assinado, não `aal` declarado), as atestações
da 09 (passam o token do atestante) e os inventários do banco (tabelas e funções da 0021, com as mesmas exigências).

**Os 20 itens pedidos** (`identidade-mfa-liberacao.test.js`, salvo indicação):

| Item | Teste |
|---|---|
| Conta compartilhada recusada | "identidade individual"; "PIN não é segundo fator"; gateway (`CONTA_COMPARTILHADA`) |
| Pessoa sem identidade suficiente | "identidade individual" (`PESSOA_SEM_IDENTIDADE`) |
| PIN tratado corretamente | "PIN não é segundo fator" |
| Identidade individual validada | "identidade individual" |
| MFA ausente | "MFA ausente, expirado e antigo" |
| MFA expirado | idem |
| MFA falsificado | "MFA falsificado" (assinatura, `alg: none`, payload adulterado, carimbo em ms, carimbo depois da emissão, token do futuro) |
| Impersonação bloqueada | "ator trocado…"; gateway; `integracao-plataforma` |
| Ator trocado na mesma conta | "ator trocado" (token de outra conta); "identidade individual" (pessoa de outra conta) |
| SuperAdmin sem acesso automático | "ator trocado…" |
| Papel `finance` sem concessão v2 | "ator trocado…" |
| Atestante sem autoconcessão | "atestante…"; `integracao-plataforma` "12" |
| Unidade não liberada | "liberação…" |
| Unidade liberada sem permissão | "liberação…" |
| Mudança de unidade | "liberação…" (troca para unidade não liberada); `integracao-plataforma` "6, 7" |
| Desativação da liberação | "liberação…"; "banco — 0021" |
| Acesso por rota direta | "liberação…" (`disponibilidade` e `contexto` recusam sem menu) |
| Revogação imediata | "liberação…" (concessão e liberação); `integracao-plataforma` "8" |
| Escopo PostgreSQL | "banco — 0021" (aplicação só lê; só a autoridade altera; unidade fora dos escopos; histórico imutável); inventários |
| Falha segura da autoridade | "falha segura" (verificador, identidade, liberação e administração que falham) |

**Mutações (17/17):** prova aceitando assinatura inválida, outra conta, `aal1`, fator antigo, token expirado, PIN/OTP
como fator e `alg: none`; adaptador sem exigir verificador; pessoa de outra conta; atestante sem verificador; liberação
sem prova do próprio ator; unidade sem empresa (detectado após acrescentar a asserção de contrato do registro); banco
permitindo a aplicação alterar ou sem segundo fator recente; gateway aceitando escopo do pedido, emitindo ação sensível
sem prova ou registrando token.

## 13. Riscos

1. **MFA real não confirmado** (unidade do carimbo, comportamento após logout) — bloqueia ações sensíveis em ambiente real.
2. **MFA dormente** na plataforma: ninguém é obrigado a ter fator; quem não tiver não executa ações sensíveis no v2.
3. **PIN conhecido pelo SuperAdmin** — por isso não vale como identidade financeira.
4. **Gateway como ponto único**: indisponível = financeiro fechado (seguro, mas exige monitoramento).
5. **Impersonação** da plataforma tem bypass amplo — o v2 recusa, mas qualquer rota futura do v2 precisa passar pelo adaptador.
6. **Matriz não aprovada**; política de materialidade inexistente.
7. **Telas de posição** crescem com o histórico (§ 11).
8. **Antimalware inexistente** para documentos enviados.

## 14. Dependências

1. Confirmar a prova de MFA com token real (projeto descartável) e implementar a porta com a chave real (JWKS) no gateway.
2. Ativar MFA para quem vai operar ações sensíveis (decisão da plataforma).
3. Decisão final sobre contas compartilhadas (recomendado: recusar).
4. Escolha e aprovação da hospedagem (§ 7) e cotações.
5. Aprovação da matriz 23a.
6. Teste de leitor de tela por pessoa.

## 15. Plano de implantação futura (só planejamento)

| Etapa | O que | Saída | Autorização |
|---|---|---|---|
| 1 | Aprovação da arquitetura (§§ 5–7) | Decisão de hospedagem | Responsável técnico + empresa |
| 2 | Provisionamento autorizado de homologação | Banco, gateway, cofre vazios | Em palavras próprias, por recurso |
| 3 | Instalação segura do banco e gateway | Papéis, rede privada, segredos separados | Idem |
| 4 | Migrações 0001–0021 em homologação | `fv2_migracao` com hashes conferidos | Idem |
| 5 | Configuração do cofre | Bucket privado, criptografia, antimalware | Idem |
| 6 | Validação de MFA e identidade | Token real confirma a prova; contas pessoais com MFA | Idem |
| 7 | Testes de integração | Suíte contra a homologação remota | — |
| 8 | Testes de segurança | Barreiras, mutação, escopo, gateway | — |
| 9 | Validação financeira | Competência sintética conferida | Responsável financeiro |
| 10 | Aprovação de políticas | Matriz 23a assinada | Responsável financeiro |
| 11 | Backup e restauração | Ensaio documentado | — |
| 12 | Implantação com funcionalidade desligada | Rotas atrás do adaptador; liberação desligada | Explícita |
| 13 | Ativação restrita | Uma unidade piloto | Explícita, específica |
| 14 | Monitoramento e reversão | Alarmes; desligar a liberação devolve o financeiro atual | — |

## 16. Critérios de GO/NO-GO

**GO para a etapa 1–2 (aprovar arquitetura e provisionar homologação remota com dados sintéticos)** se: § 14 itens 3 e
4 decididos; suítes verdes; nenhuma credencial em Git. **NO-GO para ações sensíveis em qualquer ambiente real** enquanto
§ 14 item 1 estiver aberto. **NO-GO para produção** enquanto §§ 13–14 tiverem itens abertos.

## Commits locais

| Commit | Conteúdo |
|---|---|
| `fbbda9f` | Parte 1 — prova verificada de segundo fator, identidade individual, liberação (0021), política do gateway, matriz 23a |
| (este) | Parte 2 — asserção de contrato do registro de liberação (mutante M45), este documento |

Sem push, merge ou deploy.
