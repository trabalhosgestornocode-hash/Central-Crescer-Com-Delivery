# Centro Financeiro MOVA — Execução 03: IA real, integração operacional e preparação da homologação

Data: 20/11/2026 · Branch `feat/mova-centro-financeiro` (sobre `ad0eb8d`) · **Nada publicado, nada ligado, WhatsApp de produção intocado.**
Sem dados reais: tudo nos testes é sintético. **O MOVA não está operacional nem homologado.**

## 1. Situação por item

| Situação | Itens |
|---|---|
| **Implementado e testado** | Provedor de IA real (Claude) atrás do contrato estrito; contrato com explicabilidade (campos ausentes, incertezas, justificativa, referências, período, todas as unidades, transcrição); 12 consultas financeiras por ferramentas de leitura do Financeiro v2; consulta consolidada das três unidades; valor ambíguo; áudio via porta de transcrição; contexto de conversa só pela mensagem respondida; migração 0002 (revisão de classificação, envio com lease, retenção/expurgo de evidência, papel `mova_app`); aprovador com núcleo da requisição, revisão de classificação e reprocessamento; worker contínuo; enviador de respostas; envio pelo Gateway (`enviarGrupoMova`); montagem em `fv2-integracao` com rotas autenticadas; Centro Financeiro lendo a API real |
| **Desligado por padrão** | `MOVA_HABILITADO`, `MOVA_RECEBIMENTO_HABILITADO`, `MOVA_IA_HABILITADA`, `MOVA_ENVIO_HABILITADO` (backend) e `WHATSAPP_MOVA_GRUPOS_JID`, `WHATSAPP_MOVA_ENVIO_HABILITADO` (Gateway). Sem elas: nenhuma rota nova responde (404), o Gateway não lê grupo nem envia, nenhum conteúdo vai a provedor externo |
| **Simulado** | Nos testes, o cliente da IA é um simulador que grava as requisições (nenhuma chamada real à Anthropic foi feita); o Centro Financeiro em arquivo estático mostra dados sintéticos com a faixa "Simulação" |
| **Pendente** | Chamada real à IA (exige chave e autorização para enviar documentos ao provedor); provedor de **transcrição de áudio** (Claude não ouve áudio); bucket privado de evidências; papel de login real membro de `mova_app`; concessão `ver` da identidade de serviço nas três unidades; fontes da North; UI de revisão de classificação e reprocessamento (backend pronto); grupo e sessão de homologação |
| **Homologado** | Nada |

## 2. Diagnóstico inicial (o que a Execução 02 deixou e o que faltava)
- Contratos da Execução 02 intactos (27/27). O MOVA não estava montado: só `fv2-integracao` pode importar o núcleo (regra `isolamento-estatico`), então a montagem foi feita lá (`fv2-integracao/mova.js`).
- Rotas do Financeiro resolvem o contexto pela sessão da plataforma (`comIdentidade` + `preparar`, concessão gravada); as rotas do MOVA usam exatamente esse caminho.
- O Gateway já tinha um envio seguro a grupo (`enviarGrupoInterno`, só o grupo interno). O miolo virou `enviarTextoAGrupo`, usado também por `enviarGrupoMova` (lista e chave próprias). A suíte do Gateway (1084) confirma que o envio ao grupo interno não mudou.

## 3. Provedor de IA — Claude Opus 5.5 (`ia/provedorAnthropic.js`)
**Por quê:** o SDK oficial `@anthropic-ai/sdk` já é dependência do backend (Agente Crescer); lê imagem (bloco `image`) e PDF (bloco `document`, texto + visão) nativamente; saída estruturada por JSON Schema (`output_config.format`), validada de novo no servidor (`validarSaidaDaIa`). Recusas tratadas (`stop_reason: refusal`) e fallback de servidor ligado (`fallbacks: "default"`).
**Custos/privacidade:** cada documento é uma chamada ao provedor externo — só com `MOVA_IA_HABILITADA=1` e chave na variável padrão do SDK (`ANTHROPIC_API_KEY`), nunca no repositório. Ligar implica enviar comprovantes/boletos à Anthropic: **decisão do proprietário** antes de qualquer uso com dados reais.
**Limite:** Claude não processa áudio. Áudio passa por uma porta `transcritor` (nenhum provedor escolhido); sem ela, o MOVA responde "mande por texto" e nada vai ao provedor.
**Segurança:** o modelo não recebe ferramentas; o conteúdo vai entre delimitadores e não consegue fechá-los; chaves extras (ex.: `sql`, `acao`) invalidam a saída; **o modelo nunca redige números para o grupo** — as respostas são montadas pelo motor a partir do Financeiro. Falha 429/5xx/conexão = transitória (fila tenta de novo); recusa/erro = falha de leitura com código.

## 4. Ferramentas (consultas) — `aplicacao/ferramentas.js`
Catálogo fechado, acionado pelo motor (a IA só escolhe a consulta). Todas são leituras do núcleo pela porta (contexto só `financeiro_v2.ver`, lista `OPERACOES_PERMITIDAS`):

| Consulta | Fonte no Financeiro v2 | Regra |
|---|---|---|
| FATURAMENTO | `consultarVendas` (resumo) | faturamento bruto; recebimento mostrado à parte e rotulado |
| DRE_RESUMO | `apurarCompetencia` | só indicadores, cada um com a situação; sem dado = "sem dado confirmado"; estado da competência |
| FLUXO_DE_CAIXA | `consultarFluxoDeCaixa` | caixa realizado, "não é resultado" |
| CONTAS_A_PAGAR_ABERTAS / CONTAS_VENCENDO | `consultarContasAPagar` | período explícito |
| CONTAS_A_RECEBER / RESUMO_DA_COMPETENCIA | `consultarResumoFinanceiro` | agregados |
| PENDENCIAS | `consultarPendencias` | quantidade |
| DESPESAS_POR_CATEGORIA | contas a pagar da competência | por competência, "o pagamento pode cair em outro mês" |
| SITUACAO_DE_CONTA | contas a pagar | "pago não significa conciliado" |
| CATEGORIAS / DOCUMENTOS | `consultarPlanoDeContas` / `consultarDocumentos` | contagens |
| SITUACAO_PROPOSTAS / COMPARATIVO_UNIDADES | armazenamento MOVA / contas a pagar | por unidade |

Toda resposta diz unidade e período/competência. Sem registros ⇒ "não há dados suficientes … não vou estimar". Consulta das três unidades: cada uma separada; **total só quando todas têm o valor**.
Política de privacidade atualizada: resumo da DRE e total de categoria (ex.: entregadores) passam a ser compartilháveis; dados individuais (nome, pagamento, salário), bancários, pessoais, credenciais e DRE linha a linha continuam restritos (bloqueados antes da IA).

## 5. Fluxo documental (implementado)
Mensagem → grupo autorizado → participante (registro automático) → mídia baixada pela sessão existente → evidência (sha256) → IA (contrato estrito) → validação → unidade (texto, transcrição, destinatário do documento ou resposta à pergunta) → busca de registros → duplicidade → proposta → resposta. Distingue nova obrigação, baixa de obrigação existente, transferência interna, receita (orienta fonte oficial), despesa paga, documento repetido, pedido de correção (solicitação sem comando), consulta, informação insuficiente/valor ambíguo. **Nada é aplicado pela IA.**
Correções feitas nesta execução (pegas pelos testes): (1) a unidade dita num **áudio** era ignorada — a transcrição agora conta; (2) **nova tentativa após falha transitória** era barrada como "evento já processado" — agora só bloqueia evento que já tem decisão.

## 6. Rotas do Centro Financeiro (`fv2-integracao/movaRotas.js`, montadas em `rotas.js`)
GET `/api/mova/{caixa, proposta, documento, historico, estado, erros}` (exigem `financeiro_v2.ver`); POST `/acoes/mova/{classificar, aplicar, rejeitar, reprocessar}` (exigem `aprovar`; aplicar exige `aprovar+aplicar+registrar` e a unidade com escrita liberada). Contexto **sempre** da sessão verificada; campos fora da lista recusados; unidade nunca vem do corpo. MOVA desligado ⇒ 404 `MOVA_DESLIGADO`.
A interface (`centroFinanceiroDados.js`) lê essas rotas; sem API cai em simulação rotulada; MOVA desligado mostra o estado real. Aprovar exige escolher a conta do pagamento (baixa/despesa paga). Revisão de classificação e reprocessamento: **backend pronto, sem botão ainda**.

## 7. Worker e respostas (`gateway/worker.js`)
Worker: N laços sobre a fila com lease; falha de banco registrada sem derrubar; recuperação de item preso pelo lease vencido; estado observável (`/api/mova/estado`). Enviador: chave própria; desligado ⇒ respostas ficam PENDENTE; ligado ⇒ toma com lease, envia pelo Gateway (`/internal/whatsapp/mova/messages`, HMAC, mesmo socket), grava `provider_message_id` (o eco é ignorado), tenta de novo até o teto e então FALHOU. Não toca nos envios automáticos atuais.

## 8. Banco (migração 0002, só PostgreSQL local de teste)
Revisão de dados da proposta só em AGUARDANDO_REVISAO, sem mudar tipo/unidade/valor/origem, com versão; estados ENVIANDO/lease/tentativas nas respostas; evidência com unidade dona, `expira_em` (400 dias), **exclusão segura** (`mova.expurgar_evidencias`: apaga só o conteúdo de evidência vencida que não sustenta proposta, mantém hash, audita); papel `mova_app` (sem login, sem DELETE/TRUNCATE, sem acesso ao schema do Financeiro) — testado: `delete` negado.

## 9. Gateway e o sync offline do companion
- Estado: gancho de leitura e envio prontos, ambos desligados; nenhuma credencial/sessão alterada; nenhuma segunda conexão.
- **Sync offline:** a memória do projeto e `docs/gateway-whatsapp-offline-recovery-investigacao.md` mostram que a sessão ficava em `OFFLINE_STALLED_OBSERVED` (backlog ~16 mil nós, sem nó vivo) e que isso foi **resolvido em 25/09/2026 por re-pareamento** (QR novo pelo fluxo oficial), com prova ponta a ponta de envio, recibos e inbound. As docs 01/02 diziam o contrário e foram corrigidas.
- Não reverifiquei o estado ao vivo nesta execução (não acessei o Gateway de produção). Antes de homologar: conferir na telemetria do Gateway `fase=LIVE`, `offlineFimRecebido=true` e `nosVivosVistos>0`; se o padrão parado voltar, o passo documentado é re-parear — **decisão do proprietário**, não feita aqui.

## 10. Homologação WhatsApp (não feita)
Bloqueio: não há sessão nem grupo de homologação configurados/autorizados. Passos:
1. Criar um grupo só de teste (não o Administrativo), com a conta do Gateway como participante.
2. Ambiente de teste: migrações 0001+0002; papel de login membro de `mova_app`; `MOVA_HABILITADO=1`, `MOVA_DATABASE_URL`, `MOVA_SERVICO_USUARIO_ID` (com concessão `ver` nas unidades); `instalarConfiguracao` só com o grupo de teste.
3. Ligar por etapas: recebimento (`MOVA_RECEBIMENTO_HABILITADO` + `WHATSAPP_MOVA_GRUPOS_JID`=grupo de teste) → IA (`MOVA_IA_HABILITADA`, com autorização de envio de documentos) → envio (`MOVA_ENVIO_HABILITADO` + `WHATSAPP_MOVA_ENVIO_HABILITADO`).
4. Roteiro: os 30 cenários com documentos sintéticos.

## 11. Testes (20/11/2026)
| Suíte | Resultado |
|---|---|
| MOVA: Execução 02 (27) + Execução 03 (31), PostgreSQL local, núcleo em memória | 58/58 |
| Idem com o núcleo do Financeiro v2 no PostgreSQL | 58/58 |
| Gateway (`npm test`) | 1084/1084 |
| Isolamento + whatsapp-* + integração do Financeiro | 283/283 |
| Centro Financeiro em Chrome (desktop, 375 px, escuro, API real, MOVA desligado) | 5/5 |
| Financeiro v2 completo | 732/732 (3 pulados) |
| Frontend completo | 2038/2038 (31 pulados) |
| Backend completo (`test/*.test.js`) | 6465/6510: 16 falhas + 1 cancelado, todas pré-existentes (Central de Conversas/visão, timeout do checklist, migrations 088 e 103, distribuições, selecionarPerfil) |
As falhas do backend são as mesmas já registradas antes desta branch; nenhuma toca MOVA, Gateway ou Financeiro v2.

## 12. Próxima execução (04)
Autorização e chave da IA para um piloto em grupo de teste; escolha do provedor de transcrição; bucket privado; papel de login; concessões da identidade de serviço; botões de revisão/reprocessamento; homologação em grupo de teste seguindo a seção 10.
