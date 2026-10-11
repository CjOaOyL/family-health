// Family view: members with report counts, latest collection; rename / merge / delete.
import { el, clear, append, button, chip, fmtDate, toast, select, emptyState, vendorChip, notice } from '../ui.js';
import { hashFor } from '../state.js';
import { listMembers, listReports, putMember, deleteMember, mergeMembers } from '../../src/store/db.js';

export const title = 'Family';

export async function render(root) {
  const page = el('div');
  root.appendChild(page);
  await draw();

  async function draw() {
    clear(page);
    const [members, reports] = await Promise.all([listMembers(), listReports()]);
    const byMember = new Map();
    for (const r of reports) {
      const k = r.memberId || '';
      if (!byMember.has(k)) byMember.set(k, []);
      byMember.get(k).push(r);
    }
    page.appendChild(el('div', { class: 'page-title' }, el('h1', 'Family'), el('span', { class: 'muted small' }, `${members.length} member${members.length === 1 ? '' : 's'} · ${reports.length} report${reports.length === 1 ? '' : 's'}`)));

    const addForm = addMemberForm();
    page.appendChild(addForm);

    if (!members.length) {
      page.appendChild(emptyState('No family members yet. Import a lab report and create a member from it, or add one above.', el('a', { class: 'btn', href: '#/import' }, 'Import a PDF')));
    } else {
      const list = el('ul', { class: 'members' });
      for (const m of members) list.appendChild(memberRow(m, byMember.get(m.id) || [], members));
      page.appendChild(el('section', { class: 'card' }, el('h2', 'Members'), list));
    }

    const unassigned = byMember.get('') || [];
    if (unassigned.length) {
      page.appendChild(el('section', { class: 'card' },
        el('div', { class: 'card-head' }, el('h2', 'Unassigned reports'), chip(String(unassigned.length), 'warning')),
        el('ul', { class: 'members' }, unassigned.map((r) => el('li',
          el('span', { class: 'name' }, r.report?.patient?.fullName || r.report?.source?.fileName || r.id),
          el('span', { class: 'meta' }, vendorChip(r.report?.source?.vendor), ` ${fmtDate(r.report?.specimen?.collectedAt, { time: false }) || 'no date'} · ${(r.report?.results || []).length} results`),
          el('span', { class: 'actions' }, el('a', { class: 'btn btn-small', href: hashFor('review', r.id) }, 'Review & assign')))))));
    }
  }

  function addMemberForm() {
    const name = el('input', { type: 'text', placeholder: 'Name', 'aria-label': 'Name' });
    const dob = el('input', { type: 'date', 'aria-label': 'Date of birth' });
    const sex = select({ placeholder: 'Sex', options: [{ value: 'F', label: 'F' }, { value: 'M', label: 'M' }, { value: 'U', label: 'U' }] });
    const add = button('Add member', async () => {
      if (!name.value.trim()) { toast('Name is required'); name.focus(); return; }
      await putMember({ name: name.value.trim(), dob: dob.value || null, sex: sex.value || null });
      toast('Member added');
      await draw();
    }, { kind: 'primary' });
    return el('section', { class: 'card' }, el('h2', 'Add a member'), el('div', { class: 'row' }, name, dob, sex, add));
  }

  function memberRow(m, reports, members) {
    const latest = reports.map((r) => r.report?.specimen?.collectedAt || r.report?.specimen?.reportedAt).filter(Boolean).sort().pop();
    const vendors = Array.from(new Set(reports.map((r) => r.report?.source?.vendor || 'unknown')));
    const li = el('li');
    const main = () => {
      clear(li);
      append(li, 
        el('span', { class: 'name' }, m.name, ' ', m.dob ? el('span', { class: 'muted small' }, fmtDate(m.dob)) : null, m.sex ? el('span', { class: 'muted small' }, ` · ${m.sex}`) : null),
        el('span', { class: 'meta' }, `${reports.length} report${reports.length === 1 ? '' : 's'}`, latest ? ` · latest ${fmtDate(latest, { time: false })}` : '', ' ', vendors.map((v) => vendorChip(v))),
        el('span', { class: 'actions' },
          el('a', { class: 'btn btn-small', href: hashFor('results', null, { member: m.id }) }, 'Results'),
          el('a', { class: 'btn btn-small', href: hashFor('compare', null, { member: m.id }) }, 'Compare'),
          button('Rename', rename, { small: true }),
          members.length > 1 ? button('Merge…', merge, { small: true }) : null,
          button('Delete', remove, { small: true, kind: 'danger' })),
        reports.length ? el('details', { class: 'panel', style: { flexBasis: '100%', marginTop: '6px' } },
          el('summary', { class: 'small' }, 'Reports'),
          el('div', { class: 'body' }, el('ul', { class: 'members' }, reports.map((r) => el('li',
            el('span', { class: 'name small' }, fmtDate(r.report?.specimen?.collectedAt) || fmtDate(r.report?.specimen?.reportedAt) || 'no date'),
            el('span', { class: 'meta' }, vendorChip(r.report?.source?.vendor), ` ${(r.report?.results || []).length} results · ${r.report?.audit?.label || ''} · `, el('span', { class: 'mono' }, r.report?.source?.fileName || r.id)),
            el('span', { class: 'actions' }, el('a', { class: 'btn btn-small', href: hashFor('review', r.id) }, 'Open'))))))) : null,
      );
    };
    const rename = () => {
      const name = el('input', { type: 'text', value: m.name, 'aria-label': 'Name' });
      const dob = el('input', { type: 'date', value: m.dob || '', 'aria-label': 'Date of birth' });
      const sex = select({ placeholder: 'Sex', value: m.sex || '', options: [{ value: 'F', label: 'F' }, { value: 'M', label: 'M' }, { value: 'U', label: 'U' }] });
      clear(li);
      append(li, name, dob, sex,
        button('Save', async () => { await putMember({ ...m, name: name.value.trim() || m.name, dob: dob.value || null, sex: sex.value || null }); toast('Member updated'); await draw(); }, { small: true, kind: 'primary' }),
        button('Cancel', main, { small: true, kind: 'ghost' }));
      name.focus();
    };
    const merge = () => {
      const others = members.filter((x) => x.id !== m.id);
      const target = select({ placeholder: 'Merge into…', options: others.map((o) => ({ value: o.id, label: o.name })) });
      clear(li);
      append(li, el('span', { class: 'name' }, `Merge “${m.name}” into:`), target,
        button('Merge', async () => {
          if (!target.value) { toast('Pick a member'); return; }
          const into = others.find((o) => o.id === target.value);
          if (!confirm(`Move ${reports.length} report(s) from “${m.name}” to “${into.name}” and delete “${m.name}”?`)) return;
          await mergeMembers(m.id, into.id);
          toast('Members merged');
          await draw();
        }, { small: true, kind: 'primary' }),
        button('Cancel', main, { small: true, kind: 'ghost' }));
    };
    const remove = async () => {
      if (!confirm(`Delete “${m.name}”? ${reports.length ? `Its ${reports.length} report(s) will stay stored but become unassigned.` : ''}`)) return;
      await deleteMember(m.id);
      toast('Member deleted');
      await draw();
    };
    main();
    return li;
  }
}
