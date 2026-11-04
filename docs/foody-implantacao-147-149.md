# Foody Delivery — implantação controlada das migrations 147, 148 e 149

Estrutura de banco da camada Foody (camada central, conexão compartilhada e administração pela tela). **Instalar a estrutura não
ativa nada**: sem `FOODY_CENTRAL_ADMIN_ENABLED` as rotas continuam em 404 e nenhuma flag de sincronização é tocada.

> **Bloqueadores** (nenhuma aplicação remota antes de resolver os dois):
> - **B1 — backup recuperável confirmado** no painel do Supabase do ambiente-alvo (backup do dia listado e restaurável; PITR, se
>   houver no plano) **e** dump cifrado complementar feito e conferido. Sem isso, `FOODY_BACKUP_CONFIRMADO=SIM` não pode ser dado.
> - **B2 — homologação no Supabase de TESTE** (`wiqqsxnysbzhcrzrrean`) concluída com o roteiro da §5, todos os portões verdes,
>   inclusive a recuperação e a reaplicação. Só depois disso uma janela de produção é proposta.

## 1. Por que 147, 148 e 149

A camada nasceu como 144/145/146 (PRs #75–#77). A vistoria de 04/11/2026 achou em **produção** o registro
`20261101190718 144_termo_v3_aprovado_internamente`. O Termo v3 foi aplicado em 01/11 a partir de
`docs/configuracoes-2-notificacoes/termo-v3-APROVAR-ANTES-DE-APLICAR.sql`, um arquivo que **fica fora** de `database/migrations`
de propósito. Aquele registro **não foi e não será alterado**.

Para não ter duas "144", a camada Foody foi renumerada. Os números 147–149 foram conferidos como livres em:

| Onde | Resultado |
|---|---|
| Histórico de PRODUÇÃO (`uqybgauuxcrqzquultfu`) | maior registro = `144_termo_v3_aprovado_internamente`; nada em 145–149 |
| Histórico de TESTE (`wiqqsxnysbzhcrzrrean`) | maior registro = `143_…`; nada de Foody |
| Todos os branches locais e remotos | nenhum arquivo `147_`–`159_` |

Conteúdo **idêntico** ao revisado no PR #77: só mudaram o número, as referências (comentários, mensagens de erro e textos de
rollback) e os testes. As 145/146 ficam **livres**: o salto é intencional.

**Regra:** toda checagem do histórico usa o **nome exato** (`147_foody_camada_central`, `148_foody_conexao_compartilhada`,
`149_foody_conexao_administracao`), nunca o número nem regex. `^14[4-6]_` casaria o Termo v3.

## 2. O kit (`backend/testes-seguros/foody-147-149/`)

| Arquivo | Papel |
|---|---|
| `sql_comum.mjs` | Lista fechada de objetos (8 tabelas e 16 funções), privilégios esperados, assinatura do escopo Foody e impressão de tudo FORA dele |
| `gerar_pacote.mjs` | Gera o kit a partir dos próprios arquivos de `database/migrations` (sem cópia que possa divergir). Mesmo commit = mesmos bytes |
| `implantar.mjs` | Executor: travas de alvo, SHA-256 fixado, portões e evidências. Modos `pacote`, `diagnostico`, `prevoo`, `aplicar`, `validar` e `recuperar` |

**Pacotes gerados:**

- **`pacote_aplicar.sql`** — uma transação, em cinco etapas:
  1. **Travas.** Recusa se faltar o histórico. Recusa se alguma das 3 já estiver registrada (`JA_REGISTRADA`). Recusa se existir **qualquer** objeto com `foody` no nome: tabela, função, gatilho, constraint ou tipo (`OBJETO_EXISTENTE`). Recusa se faltar uma dependência.
  2. `lock_timeout` 5 s e `statement_timeout` 120 s.
  3. 147 + 148 + 149.
  4. Registro em `supabase_migrations.schema_migrations`, com o conteúdo original de cada arquivo.
  5. **Autoverificação** (RLS, policies, anon/authenticated, DELETE do service_role, 16 funções, 3 registros). Qualquer exceção, em qualquer ponto, desfaz tudo.
- **`pacote_recuperar.sql`** — veja a §4.
- **`prevoo.sql`, `diagnostico.sql` e `posverificacao.sql`** — somente leitura, um JSON cada, rodados em sessão com `default_transaction_read_only=on`.

**SHA-256** (fixado em `implantar.mjs` e conferido pelo teste):
- `pacote_aplicar.sql` → `SHA_ESPERADO["pacote_aplicar.sql"]`
- `pacote_recuperar.sql` → `SHA_ESPERADO["pacote_recuperar.sql"]`

Mudou uma migration 147–149 ou o kit? Regenere, atualize o SHA no PR e rode o ensaio de novo.

Não há válvula de escape: com o SHA divergente o executor para em **qualquer** alvo, inclusive no ensaio local. Homologado no TESTE em 04/11/2026 com `pacote_aplicar.sql` = `feadfd82…` e `pacote_recuperar.sql` = `30f52e64…` (os mesmos fixados).

**Travas de alvo:**

- `FOODY_ALVO=producao|teste|local` + `FOODY_CONN`, só pelo ambiente do operador. A conexão nunca é lida de arquivo, impressa nem gravada; a saída é mascarada.
- Para produção e teste: host `db.<ref>.supabase.co` com usuário `postgres`, **ou** pooler de **sessão** (porta 5432) com usuário `postgres.<ref>`.
- Recusa a porta 6543 e qualquer conexão que cite o outro projeto.

## 3. Pré-voo e pós-verificação (portões)

**Pré-voo (`avaliarPrevoo`):**
- **Sessão:** somente leitura e não é réplica.
- **Histórico:**
  - existe;
  - nenhum dos 3 nomes registrado;
  - nenhum `147_`–`149_` ocupado;
  - **zero** objetos `foody`.
- **Dependências:**
  - `organizacoes`, `unidades` e `usuarios_organizacoes`, com `perfil_id`, `organizacao_id`, `papel` e `ativo`;
  - `service_role`, `anon` e `authenticated`;
  - `gen_random_uuid` e `hashtextextended`;
  - `remapear_organizacao_em_tabelas_de_unidade` descobrindo tabelas por `information_schema.columns`. Sem isso, uma transferência de unidade deixaria `foody_*` para trás.
- **Concorrência** (no banco conectado):
  - 0 locks aguardando;
  - 0 locks de escrita em `unidades`/`organizacoes`;
  - 0 sessões `idle in transaction`;
  - nenhuma transação com mais de 30 s.
- **Só em produção:**
  - Subway Saci (`…0000000000a1`) e Açaí no Grau Saci (`4d3b75bd-…`) existem, estão ativas e ficam em organizações **diferentes**;
  - o registro do Termo v3 existe.
- **Teste e produção:** WAL arquivando (`archive_mode=on`, sem falha depois do último OK) — **bloqueante** nos dois alvos.
- **Idade do último WAL arquivado (< 15 min):** **bloqueante em produção**. No **TESTE** é só **aviso** (registrado em `prevoo-portoes.json` → `avisos`): com tráfego baixíssimo o TESTE pode passar horas sem fechar um segmento, e o backup do painel é confirmado pelo operador (`FOODY_BACKUP_CONFIRMADO=SIM`).
- **Impressão fora do escopo** guardada para comparar depois.

**Pós-verificação (`avaliarPos`):**
- 8 tabelas, todas com RLS e 0 policies.
- **anon/authenticated:**
  - nenhum acesso a tabela nem a coluna;
  - nenhuma função executável;
  - PUBLIC sem EXECUTE.
- **service_role:**
  - privilégios **exatamente** os esperados (`S`/`SI`/`SIU`, nunca DELETE nem TRUNCATE);
  - os UPDATEs de coluna exigidos pela transferência;
  - EXECUTE só em `foody_conexao_administrar` e `foody_fechamento_registrar`.
- SECURITY DEFINER exatamente nas 4 funções previstas.
- **Multi-tenant:**
  - as 8 tabelas com o gatilho de tenant `foody_validar_tenant` DEFERRABLE INITIALLY DEFERRED;
  - todas com `organizacao_id` + `unidade_id`, e portanto dentro do remapeamento.
- **Integridade:**
  - FKs para `unidades`/`organizacoes`;
  - nenhuma constraint não validada nem gatilho desligado;
  - **todas as tabelas vazias**.
- **Histórico:** 3 registros, com md5 = arquivo.
- **Assinatura** estrutural registrada (`ASSINATURA.txt`).
- **Impressão FORA do escopo igual à do pré-voo.** Isso prova que Parser, Dashboard, Checklist, iFood Events, notificações e o resto do schema não mudaram.

## 4. Recuperação (nunca um rollback às cegas)

`implantar.mjs diagnostico` (somente leitura) classifica o **estado real**:

| Estado | Significado | Ação |
|---|---|---|
| `AUSENTE` | nenhum objeto, nenhum registro | pode aplicar (depois do pré-voo) |
| `COMPLETO_VAZIO` | 8 tabelas, 16 funções e 3 registros; tabelas vazias | recuperação pelo pacote **permitida**, com a assinatura |
| `COMPLETO_COM_DADOS` | instalado e já usado | **sem recuperação automática**: exportar, revogar conexões e decidir manualmente |
| `PARCIAL` | qualquer outra combinação | **PARAR**: não reaplicar, não rodar rollback; análise manual com o diagnóstico |

`FOODY_AUTORIZO=SIM FOODY_ASSINATURA=<ASSINATURA.txt> node implantar.mjs recuperar`:

1. Exige o estado `COMPLETO_VAZIO` **e** a assinatura atual = a registrada na pós-verificação.
2. O `pacote_recuperar.sql` confere **de novo, dentro da transação**:
   - os 3 registros;
   - as 8 tabelas;
   - as 16 funções;
   - **0 linhas**;
   - a assinatura, recebida por `-v assinatura=`. Sem a variável, o psql falha.
3. Só então roda o `147_rollback`, que remove só objetos `foody_*`, apaga os 3 registros e confere que não sobrou nada.
4. Depois: estado `AUSENTE` e impressão fora do escopo **idêntica** à de antes. O registro do Termo v3 não é tocado.

**Os rollbacks individuais não estão no procedimento.** Não use `149_rollback`, `148_rollback` nem `147_rollback` avulsos em ambiente remoto.

**A 148 não é reexecutável:** ela cria `ck_foody_pedidos_triagem` e `ck_foody_pedidos_inativo_minimo` sem `if not exists`. Nunca rode a 148 avulsa. Em estado `PARCIAL` (o pacote atômico não deveria produzi-lo), pare e analise.

## 5. Roteiro de homologação no Supabase de TESTE (preparado; NÃO executado)

**Pré-condições:**
- autorização específica;
- backup do projeto de TESTE conferido no painel;
- janela combinada (o TESTE é compartilhado com outras homologações).

| # | Passo | Critério para seguir |
|---|---|---|
| 1 | `node implantar.mjs pacote` no commit do PR | SHA = fixado |
| 2 | `FOODY_ALVO=teste FOODY_CONN=… node implantar.mjs diagnostico` | `AUSENTE` |
| 3 | `… prevoo` | 0 falhas; números 147–149 livres |
| 4 | Dump cifrado complementar do schema `public` do TESTE (com autorização) | sha256 conferido |
| 5 | `FOODY_AUTORIZO=SIM FOODY_BACKUP_CONFIRMADO=SIM … aplicar` | `ok:true`, `COMPLETO_VAZIO`, assinatura registrada |
| 6 | `… validar` | 0 falhas |
| 7 | **PostgREST real do TESTE:** com a chave `anon` e com um JWT `authenticated`, `GET /rest/v1/foody_conexoes` e `POST /rest/v1/rpc/foody_conexao_administrar` | **401/403/404**, nunca 200 |
| 8 | Backend local apontado para o TESTE com `FOODY_CENTRAL_ADMIN_ENABLED` **desligada** | `/integracoes/foody/estado` = 404 `DESLIGADO` |
| 9 | (Opcional, com autorização) a mesma rota com a flag ligada **só no backend local** | `/estado` 200 sem conexão; nenhuma chamada externa |
| 10 | `… recuperar` com a assinatura do passo 5 | `AUSENTE`; impressão fora do escopo idêntica |
| 11 | `… aplicar` de novo | mesma assinatura do passo 5 |
| 12 | Registrar as evidências (JSONs, sem conexão) e decidir: manter instalado no TESTE ou recuperar | — |

**Interromper** em qualquer portão vermelho. Se a aplicação falhar, o banco desfaz tudo: rodar o `diagnostico` (deve dar `AUSENTE`), registrar e **não** repetir na hora.

## 6. Produção (depois de B1 e B2)

- Mesmo roteiro, com `FOODY_ALVO=producao`.
- Os portões extras de produção (unidades do piloto e Termo v3) já estão no `avaliarPrevoo`.
- Janela sugerida: dia útil, 07:00–07:45 BRT, longe do relatório das 16:30 e dos envios D-1 (10h, 11h e 20h).
- Depois: `/health` ok, iFood Events `active`, Checklist respondendo e rotas Foody 401/404.
- Ativação (segredo e flags) é **outra** decisão, com GO próprio.

## 7. Ensaio local (o que o PR prova)

`backend/test/foody-implantacao-147-149-pg.test.js` roda o executor real num Postgres descartável: o schema real até a 143, mais um histórico com o registro do Termo v3. Ele cobre:

- **Kit:** SHA fixado, determinístico, histórico por nome exato.
- **Travas de alvo.**
- **Pré-voo.**
- **Erros simulados:**
  - lock em `unidades`: barrado no pré-voo, e o pacote direto cai no `lock_timeout`;
  - falha no registro do histórico: tudo desfeito;
  - estado parcial: recusado.
- **Aplicação:** pós-verificação aprovada e impressão fora do escopo idêntica.
- **Reaplicação recusada.**
- **Isolamento:** anon/authenticated e DELETE do service_role, mais detecção de deriva de privilégio.
- **Recuperação recusada** sem autorização, com assinatura errada, sem a variável, com dados e com deriva estrutural.
- **Recuperação e reaplicação**, com a mesma assinatura.
- **Transferência real** de unidade sobre a camada instalada pelo pacote.

```
CHECKLIST_PERFIL_PG_URL=postgresql://postgres@127.0.0.1:<porta>/postgres FOODY_PSQL=<psql> \
  node --test test/foody-implantacao-147-149-pg.test.js
```
