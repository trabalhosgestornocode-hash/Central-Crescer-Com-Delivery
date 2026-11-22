# MOVA — banco operacional em produção (schema `mova`)

O estado do MOVA em operação (conversas, decisões, propostas, auditoria, fila, orçamento de IA, entregadores, automações) fica num schema **próprio**, `mova`, no banco de produção. Ele não reutiliza o banco de homologação, e os dois nunca se misturam:

- a instalação **aborta** se o banco tiver o marcador `MOVA_HOMOLOGACAO:`;
- o backend em `MOVA_MODO=OPERACAO` **recusa** subir se o schema não estiver marcado `MOVA_OPERACAO:<marcador>` ou se o banco for o de homologação (`exigirBancoDaOperacao`).

O MOVA **não** guarda dados financeiros. Obrigações, lançamentos e pagamentos continuam só no Financeiro v2 (`financeiro_v2`), lidos pela credencial de leitura do MOVA.

## Arquivos
- `instalar.sql`: gerado por `backend/scripts/mova/pacoteProducao.mjs` a partir de `migracoes/0001`–`0008`. Não editar à mão; o teste `agente2-pacote-producao` falha se divergir.
- `inventario.sql`: somente leitura. Rodar antes e depois.

## Procedimento (um operador por vez; registrar em COORDENACAO-AGENTES.md antes)
1. **Exclusividade.** Nenhuma outra migração em curso: o item `migracao_em_curso` do inventário deve vir `(nenhuma)`. Nenhum outro agente usando o banco.
2. **Inventário antes.** Rodar `inventario.sql` e guardar o resultado. Esperado:
   - `schema_mova = AUSENTE`;
   - `publicacoes_for_all_tables = (nenhuma)`;
   - o banco não tem o marcador de homologação.
3. **Backup.** Confirmar o backup diário do provedor (Supabase) com data de hoje, ou fazer um `pg_dump --schema-only` do banco. A instalação é aditiva, então o backup é a garantia contra o imprevisto, não parte do rollback.
4. **Instalar** como `postgres`, numa transação única: `psql -v ON_ERROR_STOP=1 -1 -f instalar.sql`, ou `apply_migration` com o arquivo inteiro. Qualquer pré-condição falhando aborta sem mudar nada.
5. **Login do MOVA, fora do repositório.** A senha é gerada na hora e guardada só no Render (`MOVA_DATABASE_URL`):
   `create role mova_operacao_login login password '<gerada>' in role mova_app;`
   O login herda só `mova_app`: sem `DELETE`, exceto em `mova.conversa_ativa`, e sem acesso a `financeiro_v2` nem a `public`.
6. **Marcar o schema** com um marcador aleatório de 12 a 64 caracteres (o mesmo valor de `MOVA_OPERACAO_MARCADOR` no Render):
   `comment on schema mova is 'MOVA_OPERACAO:<marcador>';`
7. **Inventário depois.** Esperado:
   - `schema_mova = EXISTE`, com o marcador;
   - `tabelas_mova = 27`;
   - `logins_membros_de_mova_app = mova_operacao_login`;
   - `select * from mova.mova_migracao` com 8 linhas e os sha256 do arquivo.

## Recuperação
- **Falha durante a instalação:** a transação desfaz tudo. Corrigir a causa e repetir.
- **Desfazer depois de instalado, antes de qualquer uso real:** confirmar que todas as tabelas estão vazias (`select count(*)` em cada uma) e então `drop schema mova cascade; drop role mova_operacao_login;`. **Nunca** com dados reais: com uso real, desligar o MOVA (`MOVA_HABILITADO=0` ou `MOVA_SUSPENSO=1`) e manter o histórico.
- **Interrupção de emergência em operação:**
  - `MOVA_SUSPENSO=1` no Render, que reinicia o serviço;
  - ou, em tempo real, o controle do MOVA (`mova.controle`) com processamento, envio ou IA desligados;
  - ou suspensão individual pela Central de Operações.
