# Foody Delivery — administração pela Crescer (migration 149)

Tela: **Configurações → Integrações → Foody Delivery**. Permite que os administradores da Subway Saci e do Açaí no Grau Saci
configurem e administrem o compartilhamento da conta Foody sem suporte técnico.

Reaproveita a arquitetura dos PRs #75 (camada central, 147) e #76 (conexão compartilhada, 148). O conector (cliente, sync,
roteamento, fechamento) **não foi alterado**.

## 1. Duas chaves independentes

| Flag | Liga | Não liga |
|---|---|---|
| `FOODY_CENTRAL_ADMIN_ENABLED` | a tela e as rotas `/api/v1/integracoes/foody/*` | nenhuma coleta de pedido |
| `FOODY_CENTRAL_ENABLED` + `FOODY_CENTRAL_UNIDADES` + `FOODY_CENTRAL_AGENDADOR_ENABLED` | a sincronização (já existente) | — |
| `FOODY_CENTRAL_COMPARTILHAMENTO_ENABLED` | a distribuição para destinos na sync (já existente) | — |

* Ativar a conexão na tela **só a deixa pronta**. A coleta só acontece com as flags de sincronização. O agendador continua
  **fora** do `server.js`. Os testes de arquitetura garantem que a camada de administração não importa cliente HTTP, sync, agendador nem fechamento.
* Com a administração desligada, todas as rotas respondem 404 e a seção some da tela. **Revogar** (a conexão ou um
  compartilhamento) funciona sempre: desligar algo nunca depende de ligar outra coisa.
* Fail-closed: só o valor exato `true` liga.

No `backend/.env.example`: `FOODY_CENTRAL_ADMIN_ENABLED=false`.

Com as migrations ainda não aplicadas (produção logo após o merge), as revogações chegam ao banco e respondem **404
`NAO_INSTALADA`**: não há nada para revogar, e a resposta nunca é 500 nem traz SQL.

## 2. Quem pode o quê

| Ação | Quem |
|---|---|
| Ver o estado | `integracoes.gerenciar` (Administrador ou Gestor de unidade). Superadmin em impersonação só consulta. |
| Cadastrar, ativar, pausar, revogar, trocar token, ponto de coleta | organization_admin **ativo** da organização da unidade |
| Propor compartilhamento | organization_admin da titular, para empresas em que ele **também tem vínculo** (a lista da plataforma nunca é exposta) |
| Aprovar | organization_admin do destino, **no contexto do destino** (ato separado). A titular não aprova pelo destino. |
| Revogar compartilhamento | organization_admin de qualquer um dos lados, com motivo |
| Decidir a triagem | organization_admin da titular ou de um destino **ATIVO**, com justificativa |

Cada escrita é conferida três vezes: pelo middleware (sem escrita em impersonação), pelo serviço (papel da sessão) e **pelo banco**
(`foody_eh_admin_da_organizacao` lê `usuarios_organizacoes` no momento da ação). Papel perdido depois do login é recusado.

## 3. Rotas (`/api/v1/integracoes/foody`, montadas no tenant)

| Método | Caminho | Observação |
|---|---|---|
| GET | `/estado` | conexão (sem token), compartilhamentos com nomes, estado da sync, auditoria |
| POST | `/conexao` | `{ token, pontoColetaEsperado? }`. Nasce **PAUSADA**. Limite de 10 tentativas a cada 15 min. |
| POST | `/conexao/token` | troca o token (volta a PAUSADA). Recusada com compartilhamento vivo. |
| POST | `/conexao/ativar` · `/conexao/pausar` · `/conexao/revogar` | revogar exige `motivo` |
| PUT | `/conexao/ponto-coleta` | |
| GET | `/destinos-possiveis` | só empresas do próprio administrador |
| POST | `/compartilhamentos` · `/compartilhamentos/:id/aprovar` · `/compartilhamentos/:id/revogar` | |
| GET | `/conexoes/:id/triagem/dias` · `/conexoes/:id/triagem?competencia=` · `/conexoes/:id/triagem/decisoes` | visualização mínima |
| POST | `/conexoes/:id/triagem/:foodyUid/decisao` | `{ operacao, motivo }`. Vale na próxima sincronização. |

As respostas não são cacheadas (`no-store`). Erros 4xx têm código estável e 5xx são genéricos. As respostas de escrita trazem só o que
a tela usa, **sem ids de perfil**: a autoria aparece como "Você" ou "Outro administrador".

## 4. Proteção do token

* O token só trafega no **corpo** do POST. O campo da tela é do tipo senha, sem autocompletar, e é esvaziado antes do envio.
* É cifrado em AES-256-GCM com AAD da unidade (`FOODY_CENTRAL_SECRET`). No banco ficam só o texto cifrado e a impressão
  (12 hex do sha256). A tela mostra os **4 últimos caracteres da impressão**, nunca o token.
* Sem o segredo no ambiente: 503 `SEGREDO_AUSENTE`, e nada é gravado.

## 5. Garantias do banco (149)

* `foody_conexao_administrar(...)`: uma função `SECURITY DEFINER` (só `service_role` executa) com advisory lock por unidade.
  Cada ação gera um evento em `foody_conexoes_eventos`. Repetir o estado atual devolve `SEM_MUDANCA`, sem evento.
* **Dupla contagem**:
  * uma conta (impressão) tem só uma conexão viva (147);
  * a unidade que é destino vivo não tem conexão própria (trigger em `foody_conexoes`, vale para qualquer escrita);
  * o token não troca com compartilhamento vivo;
  * um destino vivo por operação (148);
  * o pedido nunca fica ativo em duas unidades (148).
* **Mudança de organização** (transferência ou promoção da unidade):
  * a conexão ATIVA volta a PAUSADA;
  * o evento `PAUSADA_POR_TRANSFERENCIA` fica na **nova** organização;
  * os destinos caem (148);
  * os eventos são remapeados por `remapear_organizacao_em_tabelas_de_unidade`.
* Eventos imutáveis: o UPDATE só altera `organizacao_id` e o DELETE é recusado. RLS ligado, sem policies, nada para `anon`/`authenticated`.
* Rollback: `149_rollback.sql` é fail-closed se houver eventos. `148_rollback.sql` se recusa enquanto a 149 existir. `147_rollback.sql` remove tudo.

## 6. Limitação atual: propostas só entre empresas com administrador em comum

Nesta fase **não há sistema de convites**. A lista de destinos da proposta mostra apenas as empresas em que o **próprio
administrador que propõe** tem vínculo ativo (qualquer papel). Assim, a tela nunca vira um catálogo das empresas da plataforma,
e ninguém consegue mandar uma proposta para uma empresa desconhecida digitando um id (resposta `DESTINO_NAO_PERMITIDO`).

Consequências e caminho de uso:
* Subway Saci → Açaí no Grau Saci: funciona quando quem propõe tem acesso às duas empresas (é o caso de hoje).
* Se a pessoa da titular não tiver acesso à empresa destino, a lista vem vazia e a tela explica. O Administrador da plataforma
  inclui a pessoa na empresa destino (com qualquer papel), ou quem já está nas duas faz a proposta.
* A **aprovação** continua exigindo organization_admin **do destino**, no contexto do destino. Ter acesso à empresa destino (por
  exemplo, como Operação) permite propor para lá, mas nunca aprovar por ela: o banco recusa.
* Convite entre empresas sem vínculo comum (código, aceite e expiração) fica para uma fase futura, se necessário.

## 7. Ativação (fora deste PR — exige GO próprio)

1. Backup e aplicar **147 → 148 → 149** no Supabase, só pelo pacote atômico e com o procedimento de
   [foody-implantacao-147-149.md](foody-implantacao-147-149.md) (numeração: a 144 de produção é o Termo v3).
2. Configurar `FOODY_CENTRAL_SECRET` (mínimo de 32 caracteres) no Render.
3. Ligar `FOODY_CENTRAL_ADMIN_ENABLED=true`. A tela aparece e nada é coletado.
4. Cadastrar a conta na unidade titular, propor o compartilhamento e aprová-lo pelo Açaí.
5. Só depois, numa decisão separada, ligar a sincronização para a unidade (allowlist) e acompanhar o piloto.

## 8. Testes

| Arquivo | O quê |
|---|---|
| `backend/test/foody-admin.test.js` | HTTP real sobre o banco falso: flags, permissões, impersonação, token, ciclo, dupla contagem, compartilhamento, isolamento, triagem |
| `backend/test/foody-admin-migration-pg.test.js` | 149 em Postgres descartável: admin no banco, guardas, transferência, imutabilidade, privilégios, rollbacks |
| `backend/test/foody-admin-e2e-pg.test.js` | ponta a ponta: tela → banco real → sync com a API falsa → triagem → revogação |
| `frontend/test/configuracoesFoody.test.js` | regras da tela e contratos do token |
| `frontend/test/configuracoesFoody.browser.test.js` | Chrome real, rotas reais: 390px sem rolagem, teclado, rótulos, diálogos, tema escuro, seção oculta quando desligada |
