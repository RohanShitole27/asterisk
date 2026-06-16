import { useState, useEffect, useCallback } from 'react';
import type { Contact } from '../types/sip';

/** Strip everything but digits, then drop a leading country code "1" for 11-digit numbers. */
function normalize(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}

export function useContacts() {
  const [contacts, setContacts] = useState<Contact[]>([]);

  const load = useCallback(() => {
    fetch('/api/contacts')
      .then((r) => r.json())
      .then(setContacts)
      .catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);

  /** Returns the contact's name if `number` matches a saved extension, else null. */
  const lookupName = useCallback((number: string): string | null => {
    const target = normalize(number);
    if (!target) return null;
    const match = contacts.find((c) => normalize(c.extension) === target);
    return match?.name ?? null;
  }, [contacts]);

  return { contacts, lookupName, reloadContacts: load };
}
