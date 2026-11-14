# Financeiro v2 — 28. Guia de implantação e ativação controlada (Açaí no Grau Saci)

Data: 14/11/2026. Branch local `feat/financeiro-v2-producao`. **Nada deste guia foi executado.** Cada etapa marcada
com 🔒 exige a autorização específica do proprietário, em palavras próprias, para aquela operação.

## 0. Artefatos (conferir antes de qualquer passo)

| Artefato | Conferência |
|---|---|
| `database/financeiro-v2/producao/instalar.sql` | sha256 `b5daa3cbbea6a9ec6f78507deb9576be059abab1528bb9992da8a5701f477a76` (`node backend/scripts/fv2/pacoteProducao.mjs --conferir` = "em dia") |
| `database/financeiro-v2/producao/inventario.sql` | só leitura; sha256 `2dad513548d38ab80cd03c75451adea4fcf095eb450bd48e6f2374521e51c005` |
| `database/financeiro-v2/producao/desativar.sql` | reversão não destrutiva; sha256 `db9bafe89bd1fe024e30b2d47d45420db53cc05f1fcbb75141e9e4242413ca17` |
| Código | backend `src/modules/fv2-integracao/` + `src/fv2-gateway/`; interface `frontend/financeiro-v2/` (modo plataforma) |

## 1. Checklist de backup (antes da instalação) 🔒

- [ ] Painel do Supabase → Database → Backups: backup diário recente **concluído** (anotar data/hora) e, se o plano
      tiver, PITR ativo (anotar a janela).
- [ ] Lembrete: o backup/PITR restaura o **projeto inteiro** — não é o desfazer do v2. O desfazer do v2 é o § 6.
- [ ] Foto "antes": rodar `inventario.sql` (só leitura) e anotar `itens` e `sha256`. Referência de 14/11: 1.794 itens,
      `36bfe8692c47…` (pode mudar com o uso normal da plataforma — vale a foto do dia).

## 2. Checklist de replicação / tempo real (antes da instalação)

Consulta só leitura (já executada em 14/11: nenhuma publicação `FOR ALL TABLES`; `supabase_realtime` com 0 tabelas):

```sql
select pubname, puballtables from pg_publication;
select count(*) from pg_publication_tables where pubname = 'supabase_realtime';
```

- [ ] Nenhuma publicação com `puballtables = true` (o pacote também aborta nesse caso).
- [ ] Depois da instalação: `select count(*) from pg_publication_tables where schemaname = 'financeiro_v2'` = 0 (o
      pacote já confere e aborta se não for).

## 3. Instalação no projeto existente 🔒

1. Aplicar `instalar.sql` **inteiro**, numa transação, como `postgres` (ex.: `apply_migration` do Supabase). Ele aborta
   sozinho se: o schema ou papéis `fv2_*` já existirem; o executor for superusuário ou não tiver CREATEROLE; houver
   publicação `FOR ALL TABLES`; e, ao fim, se qualquer pós-condição falhar (RLS, funções protegidas, nenhuma função ou
   tabela alcançável por anon/authenticated/service_role/authenticator, guardião sem membro utilizável, nenhuma tabela
   em replicação, nenhum papel com login).
2. Foto "depois" com `inventario.sql`: **sha256 igual** ao "antes" (só o v2 mudou). Diferente = investigar antes de
   seguir (não é para seguir "porque parece ok").
3. Resultado: **instalado mas desativado** (sem papéis de login, sem rota ligada).

## 4. Credenciais e gateway 🔒 (o proprietário executa; nada passa pelo Git nem pelo chat)

- Papéis de login e senhas: doc 26, § 3 (`\password` no psql; nunca no editor SQL).
- Gateway no Render: *Private Service* (mesmo padrão do `gateway-whatsapp`), `rootDir: backend`, build `npm ci`,
  start `node src/fv2-gateway/servidor.js`, região Ohio, porta 10000, plano Starter (custo a confirmar no painel).

### Variáveis (sem valores)

| Serviço | Variável | Valor na ativação |
|---|---|---|
| backend | `FV2_HABILITADO` | `0` até o § 5; depois `1` |
| backend | `FV2_ESCRITA_HABILITADA` | `0` (só consulta) até as condições do § 5.3 |
| backend | `FV2_HOMOLOGACAO_HABILITADA` | `0` até a matriz 24a aprovada |
| backend | `FV2_APP_DATABASE_URL`, `FV2_GATEWAY_URL`, `FV2_GATEWAY_CHAVE`, `FV2_PG_CA`, `FV2_APP_POOL_MAX` (4) | doc 26 |
| gateway | `FV2_AUTORIDADE_DATABASE_URL`, `FV2_GATEWAY_CHAVE`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `FV2_PG_CA`, `PORT=10000`, `FV2_AUTORIDADE_POOL_MAX` (2) | doc 26 |

Faltando qualquer variável obrigatória, o v2 **fica desligado** (o backend registra `FV2_DESLIGADO_POR_CONFIGURACAO`;
o gateway não sobe).

## 5. Ativação exclusiva do Açaí no Grau Saci 🔒

### 5.1 Publicação desligada
- [ ] Deploy do backend com `FV2_HABILITADO=0` (o menu segue idêntico; `/api/v1/financeiro-v2/status` responde "desligado").
- [ ] Demais módulos conferidos (login, seleção de unidade, Dashboard Financeiro atual, checklist, iFood, Foody).

### 5.2 Ligar para consulta
- [ ] IDs reais de empresa e unidade obtidos da **sessão autenticada** de quem vai liberar (nunca digitados de memória).
- [ ] `FV2_HABILITADO=1` com gateway no ar (`GET /saude` do gateway pela rede privada).
- [ ] Administradora financeira indicada (conta pessoal, TOTP ativo, vínculo com a unidade) — provisionamento com
      atestante administrador da empresa, TOTP recente (doc 26, § 4).
- [ ] Liberação da **empresa e só desta unidade** pela autoridade, com TOTP recente (`fv2_liberacao_alterar`).
- [ ] Verificação final (§ 7) sem criar nenhum lançamento.

### 5.3 Abertura financeira (sem importar saldos antigos; nada começa em zero presumido)
- [ ] Plano de contas implantado do modelo (`/acoes/configuracoes/implantar-plano`).
- [ ] Contas bancárias e caixa cadastrados; **saldo de abertura** de cada uma registrado com o extrato do último dia
      antes da competência inicial (sem extrato = "saldo desconhecido" visível, nunca zero).
- [ ] Contas a pagar/receber em aberto na data de corte registradas a partir dos documentos de origem.
- [ ] Escrita (`FV2_ESCRITA_HABILITADA=1`) só depois do TOTP comprovado em login real e com a pessoa provisionada.

## 6. Reversão (sem apagar nada)

1. Desligar a liberação da unidade (autoridade, TOTP) → o Dashboard Financeiro volta ao painel atual na próxima abertura.
2. `FV2_HABILITADO=0` no backend → nenhuma rota do v2 responde além de `/status`.
3. Se necessário, `desativar.sql` → corta login e uso dos papéis do v2; dados, objetos e histórico ficam.
4. Reverter o deploy da aplicação (commit anterior) — o banco não precisa voltar.
Remover o schema só com decisão explícita e backup verificado (fora deste guia).

## 7. Verificação final (não destrutiva)

| # | Verificação | Como |
|---|---|---|
| 1 | Login atual | entrar normalmente |
| 2 | Unidade correta | seletor da plataforma = Açaí no Grau Saci |
| 3 | Menu abre o v2 | Dashboard Financeiro → página do v2 |
| 4 | Sem dashboard duplicado | o painel antigo não aparece nessa unidade |
| 5 | Unidade não habilitada no antigo | trocar para outra unidade → painel atual |
| 6 | Sem concessão → negado | conta sem concessão do v2 |
| 7 | Troca de unidade sem vazamento | trocar e voltar; dados só da unidade ativa |
| 8 | Schema correto | `select count(*) from financeiro_v2.fv2_migracao` = 21; nada `fv2_*` no `public` |
| 9 | Escrita efetiva | só quando liberada (§ 5.3) |
| 10 | DRE sem valores sintéticos | competência sem lançamentos mostra "sem dados", nunca zero inventado |
| 11 | Documentos protegidos | envio/abertura respondem "indisponível" (cofre desligado) |
| 12 | Sensíveis exigem MFA | conceder sem TOTP recente → recusado |
| 13 | Desativação | desligar a liberação → volta ao painel atual |
| 14 | Demais módulos | navegação geral |
| 15 | Banco sem alteração indevida | `inventario.sql` = foto do § 3.2 |

## 8. O que continua bloqueado por decisão de segurança

Homologação/reabertura (matriz 24a não aprovada), arquivos (sem antimalware), remoção do legado (doc 24b, autorização
própria). A participação ADMIN implícita do `postgres` no guardião e o acesso administrativo do Supabase foram aceitos
pelo proprietário (A-2 de 14/11).
