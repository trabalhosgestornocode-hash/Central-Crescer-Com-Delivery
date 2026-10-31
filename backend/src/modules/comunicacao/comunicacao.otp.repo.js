// Reservas de envio do OTP da Central (migration 138). Só RPCs: nenhuma leitura/escrita de número, código ou texto.
import { supabase } from "../../config/supabase.js";

const db = (deps) => deps?.supabase ?? supabase;

export async function reservarEnvioOtp({ desafioId, maxHora, maxDia, maxSimultaneos }, deps = {}) {
  const { data, error } = await db(deps).rpc("comunicacao_otp_reservar",
    { p_desafio_id: desafioId, p_max_hora: maxHora, p_max_dia: maxDia, p_max_simultaneos: maxSimultaneos });
  if (error) throw new Error(`otp_reservar: ${error.code ?? "erro"}`);
  return data?.resultado ?? null;
}

export async function registrarResultadoOtp({ desafioId, status, motivo }, deps = {}) {
  const { data, error } = await db(deps).rpc("comunicacao_otp_registrar_resultado", { p_desafio_id: desafioId, p_status: status, p_motivo: motivo ?? null });
  if (error) throw new Error(`otp_resultado: ${error.code ?? "erro"}`);
  return data === true;
}
