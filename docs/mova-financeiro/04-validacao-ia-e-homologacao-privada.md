# Centro Financeiro MOVA — Execuções 04A e 04B: IA real com dados fictícios e homologação privada

Data: 20/11/2026 · Branch `feat/mova-centro-financeiro` · **Nada publicado. WhatsApp de produção intocado. Nenhum lançamento real.**
O número do contato de homologação NÃO está neste repositório (público): entra só pela configuração do ambiente.

## 04A — Primeira validação real da IA

**Configuração:** a chave `ANTHROPIC_API_KEY` está no `backend/.env` da pasta principal (o `.env` de produção do backend; o
worktree não tem `.env`). O script `backend/scripts/mova/validacaoIaReal.mjs` lê **somente** essa linha do arquivo indicado em
`MOVA_ENV_ARQUIVO` — nenhuma outra variável de produção entra no processo — e nunca imprime a chave. Teto: 10 chamadas e US$ 1
por execução; para cedo se a chamada mínima falhar. MOVA e núcleo do Financeiro em memória, dados 100% fictícios.
Para o servidor: definir `ANTHROPIC_API_KEY` no ambiente do backend de homologação (o SDK a lê sozinho) e `MOVA_IA_HABILITADA=1`.

**Autenticação:** OK. **Modelo:** `claude-opus-5-5` disponível na conta (Models API: "Claude Opus 5.5", 1M de contexto).

**Defeitos encontrados e corrigidos (só apareceram com a API real):**
1. O JSON Schema usava `minimum`, `maxLength` e `maxItems` → 400. Removidos do schema (limites seguem no servidor, `validarSaidaDaIa`).
2. Enum com `type: ["string","null"]` → 400. Anuláveis agora são `anyOf: [esquema, {type: "null"}]`.
3. Um 400 era rotulado como "recusa da IA" → agora `IA_REQUISICAO_INVALIDA` (e `IA_SEM_AUTORIZACAO` para 401/403).
As tentativas com schema inválido foram recusadas pela API antes do modelo (0 tokens).

**Resultados (chamadas reais, dados fictícios):**
| Cenário | Esperado | Obtido |
|---|---|---|
| Chamada mínima ("material de limpeza R$ 120,00") | contrato válido | válido; R$ 120,00; intenção INFORMAR_PAGAMENTO |
| 1. Nova conta a pagar (boleto PDF fictício) | PROPOSTA / NOVA_OBRIGACAO | ✅ R$ 480,00, vencimento 30/10/2026 |
| 2. Comprovante de obrigação existente | PROPOSTA / BAIXA_DE_OBRIGACAO | ✅ baixa de R$ 350,00 |
| 3. Transferência entre contas próprias | ORIENTACAO / transferência | ✅ não virou despesa |
| 4. Valor ambíguo (recibo com dois totais) | PEDIR_INFORMACAO / VALOR_AMBIGUO | ✅ |
| 5. Unidade não identificada | PEDIR_INFORMACAO | ✅ pergunta padrão |
| 6. Faturamento (venda fictícia) | CONSULTA / FATURAMENTO | ✅ R$ 1.840,50; recebimento separado |

## 04B — Homologação privada

### Implementação
**Gateway** (`gateway-whatsapp/src/movaHomologacao.js`, `movaGrupo.js`, `baileysSession.js`):
- Desligada por padrão; liga só com `WHATSAPP_MOVA_HOMOLOGACAO_CONTATO` (E.164 sem `+`) **e**
  `WHATSAPP_MOVA_HOMOLOGACAO_CONFIRMACAO=privada-somente-homologacao` (texto exato). Formato inválido derruba o boot.
- **Identidade verificada pelo WhatsApp**, não pelo número declarado: `onWhatsApp` (mesma função do envio individual) devolve o
  JID canônico e o LID; passa só mensagem cujo `remoteJid` é esse JID (com ou sem device) ou esse LID, ou chat LID com
  `senderPn` igual ao JID. Resolução por socket (reconexão resolve de novo); falha = nada passa.
- Própria conta, outros contatos privados e stubs: ignorados. Grupos: inalterados.
- Envio: a mesma rota do MOVA aceita o JID privado **só** se for o contato verificado no socket atual e com
  `WHATSAPP_MOVA_ENVIO_HABILITADO=1`. Mesmo socket, nenhuma credencial/pareamento alterado.

**Backend:** contrato e adaptador aceitam JID de telefone; a configuração só admite conversa privada em modo `HOMOLOGACAO`, que
exige `MOVA_MODO=HOMOLOGACAO` **e** `MOVA_AMBIENTE=homologacao`; fora disso a conversa privada nem é carregada do banco.
Conversa privada não autorizada é descartada **sem nenhum registro** (nada de terceiros fica guardado).
Migração 0003 (só teste): tipo da conversa (`GRUPO` | `PRIVADO_HOMOLOGACAO`), formato por tipo e no máximo uma conversa privada ativa.

**Correção encontrada com a IA real:** um cupom fiscal fictício já pago foi lido como `NOTA_FISCAL` e o motor pediu "vencimento".
Agora nota fiscal com intenção "informar pagamento" e sem vencimento segue o caminho de pagamento (baixa ou despesa paga); sem
data de pagamento, o MOVA pergunta a data (não presume pela emissão).

### Configurações (todas desligadas por padrão)
| Onde | Variável | Efeito |
|---|---|---|
| Gateway | `WHATSAPP_MOVA_HOMOLOGACAO_CONTATO` + `WHATSAPP_MOVA_HOMOLOGACAO_CONFIRMACAO` | recebe só o contato verificado |
| Gateway | `WHATSAPP_MOVA_ENVIO_HABILITADO` | responde só a ele (e aos grupos do MOVA, se houver) |
| Backend | `MOVA_MODO=HOMOLOGACAO` + `MOVA_AMBIENTE=homologacao` | admite a conversa privada configurada |
| Backend | `MOVA_HABILITADO`, `MOVA_RECEBIMENTO_HABILITADO`, `MOVA_IA_HABILITADA`, `MOVA_ENVIO_HABILITADO` | como na Execução 03 |
| Banco de homologação | `instalarConfiguracao` com o JID do contato e unidades de TESTE | nunca as três empresas reais |

### Testes
**Simulados (sem rede):** backend 16/16 em `homologacaoPrivada.test.js` (os 15 obrigatórios + o achado do cupom); Gateway
5 novos em `movaHomologacao.test.js`. Suítes: MOVA 74/74 (memória e PostgreSQL), Gateway 1089/1089, regressões relacionadas
988/989 (a falha é a pré-existente da migration 088).
**Reais com a IA (dados fictícios, conversa privada fictícia):** 3/3 — despesa paga, baixa de obrigação, transferência interna.

### WhatsApp real — NÃO realizado (bloqueio documentado)
- **Recebimento real:** não testado. **Resposta real:** não testada.
- Motivo: a única sessão Baileys existente é a do número de **produção**, num Gateway de produção. Testar exigiria publicar este
  código no Gateway de produção e ligar variáveis nele (deploy proibido nesta execução) e usar a sessão real; e não existe ainda
  um backend/banco de homologação isolado com unidades de teste. Isolamento insuficiente ⇒ envio e recebimento reais
  continuam desligados, conforme a instrução.

### Consumo da Anthropic (04A + 04B)
| Rodada | Chamadas com resposta | Entrada | Saída | Custo estimado |
|---|---|---|---|---|
| 04A (grupo sintético) | 7 | 27.996 | 3.562 | US$ 0,18 |
| 04B privado (1ª, com o defeito) | 4 | 15.516 | 2.105 | US$ 0,10 |
| 04B privado (após correção) | 4 | 15.516 | 2.144 | US$ 0,10 |
| **Total** | **15** | **59.028** | **7.811** | **≈ US$ 0,39** |
Mais 14 chamadas recusadas por schema inválido (0 tokens). Preço usado: US$ 4/MTok entrada e US$ 20/MTok saída (Opus 5.5).
Média ≈ US$ 0,026 por documento (~4,5 mil tokens de entrada, ~520 de saída, 3–9 s).
**Limite recomendado para a homologação:** até 200 chamadas e US$ 10 no total, com teto por execução (o script já impõe 10/US$ 1).

### Riscos
- A sessão de homologação real hoje seria a de produção — por isso nada foi ligado. Ideal: um número/sessão de teste num Gateway de homologação.
- Ligar a IA envia o conteúdo das mensagens à Anthropic: só com dados fictícios até decisão em contrário.
- O `.env` do backend na pasta principal é de produção: não deve ser usado como ambiente do MOVA; o script só lê a chave.
- O número do contato só pode existir em variável de ambiente (repositório público).

### Próximos passos para a homologação completa
1. Ambiente de homologação isolado: backend + banco de teste (migrações 0001–0003, papel `mova_app`, unidades de teste).
2. Gateway de homologação com sessão própria (número de teste) — ou decisão explícita do proprietário de usar a sessão de produção
   só com a conversa privada, com deploy autorizado.
3. Ligar por etapas: recebimento → IA → envio, sempre só com o contato verificado.
4. Roteiro: os 16 cenários da homologação privada com documentos fictícios; depois um grupo de teste.
