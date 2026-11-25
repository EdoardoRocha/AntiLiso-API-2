import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../shared/security/password.js';

describe('Etapa 1 — Hash de senha (scrypt)', () => {
  it('gera hashes diferentes para a mesma senha devido ao salt aleatório', async () => {
    const hash1 = await hashPassword('SenhaForte123!');
    const hash2 = await hashPassword('SenhaForte123!');

    expect(hash1).toMatch(/^scrypt\$[a-f0-9]+\$[a-f0-9]+$/);
    expect(hash1).not.toBe(hash2);
  });

  it('valida senha correta e rejeita senha incorreta ou formato inválido', async () => {
    const hash = await hashPassword('MinhaSenha#2026');

    await expect(verifyPassword('MinhaSenha#2026', hash)).resolves.toBe(true);
    await expect(verifyPassword('SenhaErrada', hash)).resolves.toBe(false);
    await expect(verifyPassword('MinhaSenha#2026', 'formato-invalido')).resolves.toBe(false);
    await expect(verifyPassword('MinhaSenha#2026', 'bcrypt$abc$def')).resolves.toBe(false);
  });
});
