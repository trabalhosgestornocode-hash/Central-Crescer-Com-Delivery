# H.4-B.5 — Central de Comunicação e Teste Controlado

Objetivo: transformar a aba **Comunicação** do Painel Administrativo numa central operacional (saúde, destinatários, histórico, configuração) e validar a
infraestrutura do WhatsApp com **uma mensagem de teste controlada**, sem scheduler, worker, alerta D-1, reforço ou aviso tardio.

## Decisões

| Tema | Decisão |
|---|---|
| Migration 096 | **Não foi necessária.** `comunicacao_mensagens.alerta_id` é anulável, `tipo` não tem CHECK e a UNIQUE(`idempotency_key`) já garante 1 criador por teste. Nenhuma coluna/enum nova. |
| Identidade do teste | `tipo = teste_comunicacao`, `metadados.proposito = teste`, `metadados.origem = teste_painel`, chave `wa:teste:{testeId}:v1`. Sem alerta. |
| Onde a mensagem nasce | `criarMensagemTeste` em `comunicacao.fila.repo.js` (a guarda de fencing só permite escrita em `comunicacao_mensagens` ali). Nasce **já reivindicada** (`PROCESSING`, `claim_geracao=1`, lease de 2 min, `max_tentativas=1`) e com `expira_em` de 10 min: o claim do worker nunca a pega. |
| Envio | Mesmas RPCs fenced (`iniciar_envio`/`finalizar_envio`), provider **só** via `WhatsAppService` (invariante mantida). Caminho real: Backend → HMAC → Gateway → `onWhatsApp` → `sendMessage`. |
| Gates (fail-closed) | ator humano; confirmação explícita; modo global **DISABLED**; Gateway conectado; WhatsApp configurado no backend; unidade ativa da empresa; destinatário com consentimento, verificado e sem opt-out; piloto ativo com o destinatário na allowlist; limite de testes. Qualquer falha ⇒ provider = 0. |
| Idempotência | O `testeId` nasce na TELA ao abrir o modal. Duplo clique/20 chamadas simultâneas ⇒ 1 mensagem e no máximo 1 provider call (só quem cria envia). |
| Limite | 1 mensagem real de teste (env `COMUNICACAO_TESTE_MAX`, 1–10). Avaliado de forma atômica **depois** da criação: numa corrida entre testes diferentes só o mais antigo envia; os outros são cancelados antes do provider. |
| Sem retry | Falha pré-envio ⇒ `FAILED`; incerto ⇒ `DELIVERY_UNKNOWN`; nunca `SCHEDULED`/reenvio. |
| Auditoria | `COMUNICACAO_TESTE_INICIADO/ENVIADO/ENTREGUE/LIDO/FALHOU` com ator (id, e-mail, perfil) e telefone mascarado; ENTREGUE/LIDO gravados **uma vez** quando o acompanhamento observa o receipt (marcador em metadados com concorrência otimista). |
| Bug do piloto | Salvar a configuração **não toca** `habilitado` (a coluna saiu do payload do upsert; o insert novo usa o default `false`). Configuração de empresa habilitada não pode ficar incompleta (`CONFIG_INCOMPLETA_HABILITADA`). Habilitar/desabilitar só pelos botões próprios. |

## Endpoints (todos atrás de `requirePainelAdministrativo`)

`GET /comunicacao/mensagens` (histórico completo, filtros), `GET /comunicacao/mensagens/:id`, `GET /comunicacao/configuracao-operacional` (somente leitura),
`GET /comunicacao/teste/preparo`, `POST /comunicacao/teste`, `GET /comunicacao/teste/:mensagemId`. `resumo` e `organizacoes` ganharam campos aditivos
(worker/último ciclo, piloto, recuperação, pipeline; contato mascarado, consentimento, unidades, última mensagem, próxima ação).

## Privacidade

Telefone só como `********NN` (últimos 2 dígitos). Nunca `conteudo`, segredo, HMAC, token, auth-state, lease/epoch, ids completos do provider (abreviados a 8).

## Limites conhecidos

- O último ciclo do worker é o da **instância que atende a requisição** (o worker é embutido; em rolling deploy cada instância tem o seu).
- Histórico: origem é derivada no serviço sobre as 500 mensagens mais recentes do filtro.
- "Recuperação de fila offline: Desativado" é a política registrada (G.4.1), não uma leitura do runtime do Gateway.
- A auditoria ENTREGUE/LIDO depende de o acompanhamento estar aberto (ou de uma nova consulta) para observar o receipt.
- O teste consome 1 da cota diária de mensagens do contato (o limite por contato não distingue origem).
