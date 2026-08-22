// The value channel: whatever the script default-exports comes back as `result.value`.
const rows = [
  { id: 1, name: 'ada' },
  { id: 2, name: 'grace' },
];

console.log(`seeded ${rows.length}`);

export default { seeded: rows.length, ids: rows.map((row) => row.id), note: null };
