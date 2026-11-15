# 31 — Rotação das credenciais de conexão do Financeiro v2

As senhas de `fv2_app_login` e `fv2_autoridade_login` passaram pelo histórico de uma sessão em 15/11. Por isso devem ser
tratadas como **potencialmente comprometidas**. A escrita controlada só será ligada depois desta rotação.

## 1. Estratégia: azul/verde, sem interrupção e sem expor senha

Existem dois pares de papéis de login com os mesmos grupos e limites:

- **Par A:** `fv2_app_login` e `fv2_autoridade_login`;
- **Par B:** `fv2_app_login_b` e `fv2_autoridade_login_b`.

A rotação prepara o par inativo com senhas novas, aponta o Render para ele e só desliga o par antigo depois que o
serviço novo estiver conectado.

- **Sem interrupção:** os papéis são separados. Durante o deploy, a instância antiga continua no par A e a nova entra
  pelo par B, sem disputar o limite de conexões.
- **Sem expor senha:** a senha nasce na memória do script (`backend/scripts/fv2/rotacaoCredenciais.mjs`). Ela vai ao
  banco só como verificador SCRAM e ao Render só pela API (`PUT /v1/services/{id}/env-vars/{chave}`). Nunca é
  impressa, gravada em arquivo ou enviada pelo chat. O conector do Render no chat **não** deve ser usado para isto,
  porque o valor apareceria no histórico, que foi justamente o problema de 15/11.
- **Nada é excluído:** o par antigo fica `NOLOGIN` e sem senha. Os grupos `fv2_app` e `fv2_autoridade`, as RLS e as
  concessões não mudam. Nenhum objeto do banco depende do nome do papel de login (conferido).

## 2. Execução (pelo proprietário, no próprio terminal)

Pré-condições:

- o deploy atual está `live`;
- `FV2_ESCRITA_HABILITADA=0`;
- a chave da API do Render (Account Settings → API Keys) está à mão;
- o certificado da CA do Supabase (`Supabase Root 2021 CA`) está num arquivo local.

```powershell
cd backend
# 0. Situação (só leitura): papéis, conexões, par em uso
node --env-file=.env scripts/fv2/rotacaoCredenciais.mjs plano

# 1. Chave do Render digitada SEM eco (não vai para o histórico do terminal nem para o chat)
$s = Read-Host -AsSecureString "Chave da API do Render"   # Windows PowerShell 5.1 (no PowerShell 7: Read-Host -MaskInput)
$env:RENDER_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)); Remove-Variable s

# 2. Cria o par novo, testa a conexão pelo pooler com TLS verificado, grava as 2 variáveis no Render e dispara o deploy
node --env-file=.env scripts/fv2/rotacaoCredenciais.mjs criar --ca <caminho\da\ca.crt> --servico srv-d96rl5naqgkc73ccflr0 --confirmar

# 3. Depois que o deploy estiver 'live': o par novo precisa ter conexões
node --env-file=.env scripts/fv2/rotacaoCredenciais.mjs validar

# 4. Desliga o par antigo (o passo 2 informa qual é): sem login, sem senha, conexões encerradas
node --env-file=.env scripts/fv2/rotacaoCredenciais.mjs revogar-antigas --antigo A --confirmar

Remove-Item Env:RENDER_API_KEY
```

O que o script garante:

- O passo 2 para antes de tocar no Render se o par novo não conectar. Também para se já houver uma rotação em andamento.
- O passo 4 se recusa a desligar o par antigo se o par novo ainda não tiver nenhuma conexão.

## 3. Validação

1. O Render mostra o deploy `live`, com as duas variáveis atualizadas (o valor não precisa ser aberto).
2. O comando `validar` mostra conexões no par novo, com o `application_name` do backend.
3. João abre o Financeiro v2 no Açaí:
   - as consultas respondem 200;
   - a outra unidade continua no financeiro antigo;
   - os logs não mostram `FALHA_FECHADA` nem 5xx.
4. Depois do passo 4, o par antigo aparece com `rolcanlogin = false`, e `pg_stat_activity` não tem conexões dele.

## 4. Verificação de exposição (antes e depois)

- Em `pg_stat_activity`, as conexões por papel (`usename like 'fv2_%'`) e o `application_name`: não deve haver nada
  além do backend e dos scripts do proprietário.
- Nos logs do Postgres no Supabase, procurar `connection authorized: user=fv2_…` desde 15/11 e comparar com os horários
  dos deploys.
  - **Limite:** o pooler (Supavisor) mascara o IP de origem, então não é possível provar a ausência de uso indevido,
    apenas procurar anomalias de horário e volume.
- Nos logs do Render, procurar erros de autenticação do v2 depois da rotação (indicariam variável errada).
- Se aparecer uso estranho: rotacionar de novo na hora e revisar o histórico do v2 (`fv2_historico`,
  `fv2_auditoria_concessao`) do período.

## 5. Reversão

- **Se o passo 2 falhar no Render** (HTTP diferente de 200):
  - o par novo existe, mas não está em uso;
  - corrigir a chave e rodar `criar ... --retomar <par novo> --confirmar`: gera senhas **novas** para o mesmo par novo, regrava
    as **duas** variáveis e dispara o deploy. Não desligue o par novo nesse caso: uma das variáveis do Render já aponta para ele.
  - `revogar-antigas` confere **cada** papel novo (app e autoridade) separadamente: se só um conecta, nada é revogado.
- **Se o deploy novo falhar:** o Render mantém a instância anterior, que continua no par antigo, ainda ativo. Corrigir e
  disparar outro deploy. O par antigo só é desligado no passo 4.
- **Próxima rotação:** o script reativa o par A com senha nova (`alter role … login password …`). Os pares alternam.
