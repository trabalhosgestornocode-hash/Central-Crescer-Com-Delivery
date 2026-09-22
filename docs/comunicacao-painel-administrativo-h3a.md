# Painel Administrativo — Comunicação/WhatsApp (Checkpoint H.3-A)

Área nova do Painel Administrativo para visualizar e preparar a comunicação
por WhatsApp — **sem enviar nada**. Objetivo: dar ao gestor visão de estado
(Gateway, worker, automação, empresas, fila, histórico) e um jeito seguro de
configurar timezone/destinatário por empresa, sem depender de SQL manual.

## O que NÃO está habilitado nesta fase

- Nenhuma mensagem é enviada. Não existe botão de envio em lugar nenhum.
- `comunicacao_configuracoes.modo` continua `DISABLED` — nenhuma rota deste
  checkpoint chama `definirModo` (confirmado por teste estático).
- `comunicacao_habilitacoes.habilitado` continua `false` para todas as
  organizações — o único endpoint de escrita **recusa** qualquer payload que
  tente `habilitado != false` (400, antes de tocar o banco). Dupla defesa:
  o `service` valida explicitamente, e o `repo` nem aceita o parâmetro.

## Rotas (mesma autorização do resto do Painel Administrativo)

Todas sob `/administrativo` (não `/painel-administrativo` — nome real do
router), protegidas por `requirePainelAdministrativo` aplicado ao router
inteiro (nenhuma checagem extra por rota):

- `GET /administrativo/comunicacao/resumo`
- `GET /administrativo/comunicacao/organizacoes?busca=`
- `GET /administrativo/comunicacao/organizacoes/:organizacaoId`
- `GET /administrativo/comunicacao/organizacoes/:organizacaoId/perfis-elegiveis` (H.3-A.1)
- `PUT /administrativo/comunicacao/organizacoes/:organizacaoId/configuracao`
- `GET /administrativo/comunicacao/fila?organizacaoId=&status=&pagina=&porPagina=`
- `GET /administrativo/comunicacao/historico?organizacaoId=&status=&tipoAlerta=&desde=&ate=&pagina=&porPagina=`

## Arquivos

**Backend** (`backend/src/modules/administrativo/`):
- `administrativo.comunicacao.repo.js` — I/O. Reaproveita
  `criarOuObterContato`/`vincularPerfil`/`perfilTemVinculo`/`mascararTelefone`
  de `comunicacao/comunicacao.contatos.repo.js` (nunca duplicados). Única
  escrita: `atualizarConfiguracaoOrganizacao` — `habilitado` é hard-coded
  `false`, não é nem parâmetro aceito.
- `administrativo.comunicacao.service.js` — validação (`v.uuid`, timezone
  IANA via `comunicacao.horario.js#timezoneValido`, tipos de alerta
  permitidos) e o gate explícito contra `habilitado != false`. Pendência
  sempre lida de `administrativo.service.js#pendencias()` — nunca
  recalculada.
- `administrativo.comunicacao.controller.js` — camada fina, mesmo padrão de
  `administrativo.controller.js` (`asyncHandler`, seam `deps(req)` para
  teste, `identidadeOperacional` para o autor da auditoria).
- Rotas montadas em `administrativo.routes.js` (edição mínima).
- 2 novas constantes de auditoria em `shared/auditoria.js`
  (`COMUNICACAO_HABILITACAO_ALTERADA`).

**Frontend** (vanilla JS, sem framework novo):
- Nova aba `comunicacao` em `TELAS_PADM` (`painelAdmViews.js`), sem seletor
  de período (mesma lista de `desenvolvimento`/`mentorados` em `painelAdm.js`).
- `htmlComunicacaoCards/Empresas/Fila/Historico` — construtores puros
  (testáveis sem DOM), reaproveitando quase 100% dos átomos visuais já
  existentes (`card`, `cards`, `chip`, `secao`, `busca`, `vazio`, `carregando`,
  `erro`, `.padm-tabela`, `.padm-abas`, `.padm-drawer`). CSS novo: só
  paginação e o formulário do drawer (`styles.css`, bloco "Comunicação").
- `painelAdmApi.js`: 6 métodos novos (`comunicacao*`), mesmo padrão de
  `chamar()`/`qs()` já usado por todo o arquivo.

## Status do worker — CONFIGURAÇÃO, nunca heartbeat (H.3-A → H.3-A.1)

O worker (`backend/src/worker-comunicacao/lifecycle.js`) guarda seu estado
real (IDLE/RUNNING/DISABLED/ERROR) só em memória, dentro do próprio processo
— e este checkpoint **não pode alterar nenhum arquivo de
`worker-comunicacao/**`** para expor um getter. Por isso o card "Worker" no
resumo reflete só a **configuração** (`COMUNICACAO_WORKER_ENABLED` ==
`"true"`), nunca uma confirmação ao vivo de que o laço está de fato rodando
saudável nesta instância — e, em rolling deploy, pode haver 2 instâncias com
estados locais diferentes ao mesmo tempo (risco já registrado no H.2-B, item
20). Por isso (Checkpoint H.3-A.1, itens 1/2):

- o rótulo é **"Habilitado"/"Desabilitado"**, nunca "Ativo" (que sugeriria um
  heartbeat real);
- o card traz uma nota explícita: "Estado baseado na configuração do
  serviço..."; 
- nenhum texto da UI usa "online"/"saudável"/"rodando" para esse card
  (provado por teste: `painelAdmComunicacao.test.js`).

Health distribuído real (uma confirmação viva, agregada entre instâncias)
fica como evolução futura — exigiria tocar `worker-comunicacao/**`.

## Seletor de destinatário (H.3-A.1, itens 3-6)

O drawer não pede mais um UUID de perfil em texto livre. Novo endpoint `GET
.../perfis-elegiveis` (`administrativo.comunicacao.repo.js#listarPerfisElegiveis`)
lista só perfis com vínculo **ativo** em `usuarios_organizacoes` PARA AQUELA
organização, mostrando nome + e-mail (join em lote com `perfis_operacionais`
+ `perfis`, nunca `for perfil: SELECT`). O frontend renderiza um `<select>`
(`htmlSeletorPerfil`); se não houver nenhum perfil elegível, mostra
"Nenhum perfil disponível para associação." em vez de virar input livre.

Frontend controlado + backend autoritativo: mesmo que alguém envie
manualmente (DevTools/curl) o UUID de um perfil de OUTRA organização, o
backend recusa com `PERFIL_SEM_VINCULO` (400) — essa validação já existia em
`atualizarConfiguracaoOrganizacao` via `perfilTemVinculo` (H.3-A); H.3-A.1
só adicionou o teste que prova isso e o combobox que evita o erro na
prática, sem mudar a regra do backend.

## KPIs do resumo: janela móvel de 24h, nunca "hoje" em UTC (H.3-A.1, itens 7/8)

"Falhas hoje"/"Enviadas hoje" era ambíguo (timezone de qual organização?) e,
pior, o valor de `falhas` nem era recortado por tempo de fato — contava o
total histórico de `FAILED`. Corrigido: `repo.contarUltimas24h()` conta
`enviado_em`/`falhou_em` dentro de `agora - 24h .. agora` (janela móvel real,
nunca truncada em meia-noite UTC, nunca no fuso de uma organização
específica) — o card é global e determinístico. Resposta do resumo agora
expõe `ultimas24h: {enviadas, falhas}` (o campo `hoje` foi removido).

## Fila/Histórico — nome da empresa resolvido no cliente (mantido de H.3-A)

Mostram o nome da empresa a partir da lista de organizações já carregada,
não via `join` no backend — evita uma segunda ida ao servidor, mas significa
que abrir a fila/histórico direto (sem passar pela aba Empresas) mostraria o
UUID como fallback. Não ocorre no fluxo normal da UI. Continua como
simplificação aceitável, não revista neste checkpoint.

## Segurança — invariantes provadas por teste (não só por leitura de código)

- `habilitado=true` (e `1`, e qualquer valor != `false`) é rejeitado com 400.
- Nenhuma rota nova referencia `definirModo` (grep estático).
- Nenhum arquivo novo importa `whatsapp.service.js`, `providers/` ou o
  Gateway (grep estático) — zero possibilidade estrutural de outbound.
- Multi-tenant: organização inexistente → 404; fila filtrada por
  `organizacaoId` nunca mistura outra organização.
- Telefone nunca aparece completo em nenhuma resposta (só mascarado).
- Falha ao gravar auditoria nunca derruba a operação principal (mesma REGRA
  DE OURO de `shared/auditoria.js`, provada com o endpoint real).

## Próximo passo (H.3-B ou piloto)

Ligar de fato uma organização (`habilitado=true`) é uma decisão de produto
explícita e futura, fora deste checkpoint — exigirá uma rota nova, dedicada,
com sua própria auditoria reforçada, provavelmente atrás de uma
allowlist/piloto explícita (como já discutido no H.0).
