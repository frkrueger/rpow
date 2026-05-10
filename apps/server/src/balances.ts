import type { PoolClient } from 'pg';

type BalanceAmount = bigint | number | string;

function amountParam(amount: BalanceAmount): string {
  return typeof amount === 'bigint' ? amount.toString() : String(amount);
}

export async function ensureUserBalance(c: PoolClient, email: string): Promise<void> {
  await c.query(
    `INSERT INTO user_balances(owner_email, valid_balance)
     SELECT $1, coalesce(sum(value), 0)::bigint FROM tokens WHERE owner_email=$1 AND state='VALID'
     ON CONFLICT (owner_email) DO NOTHING`,
    [email],
  );
}

export async function creditValidBalance(c: PoolClient, email: string, amount: BalanceAmount): Promise<void> {
  await c.query(
    `INSERT INTO user_balances(owner_email, valid_balance, updated_at)
     VALUES($1, $2::bigint, now())
     ON CONFLICT (owner_email) DO UPDATE
       SET valid_balance = user_balances.valid_balance + EXCLUDED.valid_balance,
           updated_at = now()`,
    [email, amountParam(amount)],
  );
}

export async function debitValidBalance(c: PoolClient, email: string, amount: BalanceAmount): Promise<boolean> {
  await ensureUserBalance(c, email);
  const result = await c.query(
    `UPDATE user_balances
     SET valid_balance = valid_balance - $2::bigint,
         updated_at = now()
     WHERE owner_email=$1 AND valid_balance >= $2::bigint`,
    [email, amountParam(amount)],
  );
  return result.rowCount === 1;
}
