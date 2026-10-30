# 13 — Dependências para produção (Configurações 2.0 + Central de Notificações)

Lista do que precisa existir, ser decidido ou ser autorizado **antes** de cada passo em produção. Nada aqui foi feito em produção:
nenhuma migration aplicada, nenhuma variável criada, nenhum push, PR, merge, deploy ou envio real.

## 1. Ordem de implantação sugerida

| Passo | O quê | Efeito visível | Autorização |
|---|---|---|---|
| 1 | Aplicar **132 → 133 → 134 → 135** em produção (na ordem, cada uma com o seu `_rollback.sql` à mão) | Nenhum: D-1 continua idêntico (seleção por unidade **desligada**; o resolvedor antigo é chamado igual) | aplicar migrations (palavras do usuário) |
| 2 | Publicar backend + frontend (PR → merge → deploy do serviço web **e** do estático) | Nova tela de Configurações; Central em modo consulta (sem `NOTIFICACOES_SEGREDO_MESTRE` os convites ficam indisponíveis com aviso) | PR, merge, deploy |
| 3 | Criar `NOTIFICACOES_SEGREDO_MESTRE` (≥ 32 caracteres, aleatório, guardado fora do repositório) | Convites de destinatário e pedidos de revogação habilitados; o titular **não recebe código** (transporte desligado) | variável de produção |
| 4 | Provedor oficial do WhatsApp + template de autenticação (DEP-4) e textos jurídicos (DEP-5) → nova entrega ligando o transporte real | Primeiro OTP real | nova decisão + implementação (o código hoje **recusa** transporte real) |
| 5 | Ativar a seleção por unidade (**M3**): `NOTIFICACOES_M3_ATIVACAO_HABILITADA=true` + chamada administrativa com a frase `ATIVAR SELECAO POR UNIDADE` | Snapshot imutável dos legados; D-1 passa a ser por unidade, com o MESMO resultado no instante da ativação (verificação de equivalência na transação) | ativar M3 (explícita) |
| 6 | Data de corte do fuso (`OPERACIONAL_FUSO_UNIDADE_CORTE=AAAA-MM-DD`) | Dashboard Operacional e fechamento passam a usar o fuso da unidade a partir da data | definir o corte (DEP-3) |
| 7 | SMTP no Supabase Auth + `USUARIOS_CONVITE_EMAIL=supabase` (DEP-2) | Convites de usuário passam a sair por e-mail | variável + configuração do Auth |

## 2. Variáveis de ambiente novas (nenhuma criada)

| Variável | Padrão (ausente) | Para que serve |
|---|---|---|
| `NOTIFICACOES_SEGREDO_MESTRE` | ausente → Central só consulta; convites e revogações registradas indisponíveis (503) | chave mestra (HKDF) da cifra autenticada e dos HMACs de telefone/e-mail/IP/código |
| `NOTIFICACOES_OTP_TRANSPORTE` | `desligado` | `simulacao` só vale com `NOTIFICACOES_AMBIENTE_ISOLADO=true` e `NODE_ENV≠production`; não existe valor de envio real nesta entrega |
| `NOTIFICACOES_AMBIENTE_ISOLADO` | ausente | trava da simulação (nunca definir em produção) |
| `NOTIFICACOES_M3_ATIVACAO_HABILITADA` | ausente → a rota de ativação responde 403 | libera a ativação M3 |
| `NOTIFICACOES_PALAVRA_CHAVE_SAIR` | ausente → desligada | SAIR/PARAR/STOP no WhatsApp revoga (depende do inbound, hoje parado — ver memória do companion) |
| `RATE_LIMIT_NOTIFICACOES_TITULAR_MAX` | 40 por 10 min por IP | limite das rotas públicas do titular |
| `OPERACIONAL_FUSO_UNIDADE_CORTE` | ausente → fuso da plataforma em tudo | data (AAAA-MM-DD) a partir da qual o fuso da unidade vale |
| `USUARIOS_CONVITE_EMAIL` | ausente → convite criado, e-mail **não** enviado (aviso na tela) | `supabase` usa `auth.admin.inviteUserByEmail` |

## 3. Dependências abertas (DEP)

| Id | Dependência | Bloqueia |
|---|---|---|
| DEP-1 | Alteração do Financeiro na função de transferência (`5233380`, reescreve a 120). O desenho não depende dela (nenhuma tabela nova tem o par `organizacao_id`+`unidade_id`), mas pode haver conflito de merge/teste | merge (reavaliar no pré-voo) |
| DEP-2 | SMTP próprio no Supabase Auth, template pt-BR, `/convite-usuario.html` na lista de URLs de redirecionamento. **Homologar com e-mail real**: confirmar que o Supabase preserva o `#t=` do `redirectTo` ao anexar a sessão (a página já junta fragmentos com dois `#`; se o Supabase sobrescrever o fragmento, o token precisa ir por outro meio) | primeiro convite de usuário real |
| DEP-3 | Data de corte do fuso por unidade | uso do fuso da unidade |
| DEP-4 | Provedor oficial do WhatsApp (D-13) e template de autenticação. **O Baileys não está ligado ao OTP** | primeiro OTP real / destinatário novo ativo |
| DEP-5 | Textos jurídicos do termo (versão 1 é RASCUNHO, só simulação) | primeiro consentimento real |
| DEP-6 | Decisões do grupo B (D-5, D-6, D-7, D-8, D-10, D-12) | etapas seguintes |
| DEP-7 | Autorizações: migrations, envs, PR/merge/deploy, M3, ligar a Central | cada passo |
| DEP-8 | Promoção de unidade quebrada na main (42P10, frente Financeiro) | — (não introduzida aqui) |
| DEP-9 | Verificação logada das abas novas do Dashboard 2.0 em produção (missão anterior) | — |
| DEP-10 | **Banco de teste remoto** (`teste-multiempresarial`) sem 101–105, 127 e 131: a homologação remota não foi feita; foi feita em PostgreSQL local descartável com a cadeia real da main | homologação remota, se desejada |
| DEP-11 | Inbound do WhatsApp parado (companion offline) — a palavra-chave SAIR só funciona quando o inbound voltar | palavra-chave de saída |

## 4. O que **não** muda em produção ao publicar (garantias)

- D-1: mesmo resolvedor (104 intacta), uma única linha alterada no agendador (prova de equivalência no PostgreSQL real).
- Cotas do D-1: intactas; categorias novas têm cota própria, lida só em modo consulta pela simulação.
- Função de transferência de unidades: não alterada.
- Checklist ao vivo: não alterado.
- Nenhum envio real (WhatsApp, OTP ou e-mail) é possível com as variáveis padrão.
