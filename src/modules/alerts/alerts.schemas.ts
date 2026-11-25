import { z } from 'zod';
import type { AlertChannel, AlertType, WeeklyDigestResult } from './alerts.engine.js';

export const alertTypeSchema = z.enum(['VENC', 'ORCAM', 'RESUMO']);
export const alertChannelSchema = z.enum(['PUSH', 'EMAIL', 'WHATS']);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data deve estar no formato YYYY-MM-DD');

export const listAlertsQuerySchema = z.object({
  date: dateSchema.optional(),
  unreadOnly: z.enum(['true', 'false']).optional(),
  tipo: alertTypeSchema.optional(),
  autoSync: z.enum(['true', 'false']).optional(),
});

export const syncAlertsBodySchema = z.object({
  date: dateSchema.optional(),
  canal: alertChannelSchema.default('PUSH'),
});

export const alertIdParamSchema = z.object({
  id: z.string().uuid('ID do alerta inválido.'),
});

export const markAlertReadBodySchema = z.object({
  lido: z.boolean().default(true),
});

export type ListAlertsQuery = z.infer<typeof listAlertsQuerySchema>;

export interface AlertDto {
  id: string;
  tipoAlerta: AlertType;
  mensagem: string;
  canal: AlertChannel;
  lido: boolean;
  enviadoEm: string;
}

export interface AlertsListResponseDto {
  unreadCount: number;
  createdCount: number;
  weeklyDigest: WeeklyDigestResult;
  alerts: AlertDto[];
}

export interface SyncAlertsResponseDto {
  createdCount: number;
  unreadCount: number;
  weeklyDigest: WeeklyDigestResult;
}
