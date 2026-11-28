(function (root) {
  'use strict';
  const PREFIX = 'DecentCanopy creator publication v1\n';
  const MAX_BYTES = 16000;
  const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[a-z2-7]{20,100})$/;
  const CHAINS = ['base', 'ethereum', 'optimism'];
  const REF = /^decent-(project|fund):0x[0-9a-f]{40}:[a-zA-Z0-9_-]{1,50}$/;

  function address(value, label, optional = true) {
    if (optional && (value == null || value === '')) return '';
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value)) throw new Error(`${label}: enter a non-zero 0x wallet address.`);
    return value.toLowerCase();
  }
  function refs(value, kind, label, max) {
    const list = rows(value == null ? [] : value, label, max).map(item => {
      const parts = typeof item === 'string' ? item.split(':') : [];
      const ref = parts.length === 3 ? `${parts[0]}:${parts[1].toLowerCase()}:${parts[2]}` : '';
      if (!REF.test(ref) || !ref.startsWith(`decent-${kind}:`)) throw new Error(`${label}: choose existing Decent ${kind}s.`);
      return ref;
    });
    if (new Set(list).size !== list.length) throw new Error(`${label}: remove duplicate links.`);
    return list;
  }

  function text(value, label, max = 500, optional = false) {
    if (optional && (value == null || value === '')) return '';
    if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label}: enter text, at most ${max} characters.`);
    return value.trim();
  }
  function url(value) {
    if (!value) return '';
    const parsed = new URL(text(value, 'Link', 2048));
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Links must use HTTPS, without credentials.');
    return parsed.href;
  }
  function date(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value))
      || new Date(value).toISOString().slice(0, 10) !== value) throw new Error('Use a valid date (YYYY-MM-DD).');
    return value;
  }
  function choice(value, options, label) {
    if (!options.includes(value)) throw new Error(`Invalid ${label}.`);
    return value;
  }
  function rows(value, label, max) {
    if (!Array.isArray(value) || value.length > max) throw new Error(`${label}: at most ${max} entries.`);
    return value;
  }
  function key(value) {
    const result = text(value, 'Record key', 50);
    if (!/^[a-zA-Z0-9_-]+$/.test(result)) throw new Error('Record keys may contain only letters, numbers, underscores and hyphens.');
    return result;
  }
  function amount(value) {
    if (value == null || value === '') return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('Amount must be a non-negative number or left blank.');
    return value;
  }
  function repository(value) {
    const parsed = new URL(text(value, 'Repository URL', 200));
    const parts = parsed.pathname.replace(/\/$/, '').split('/').slice(1);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.port ||
        parsed.username || parsed.password || parsed.search || parsed.hash || parts.length !== 2 ||
        !/^[a-z0-9][a-z0-9-]{0,38}$/i.test(parts[0]) || !/^[a-z0-9_.-]{1,100}$/i.test(parts[1]) ||
        ['.', '..'].includes(parts[1])) {
      throw new Error('Use a public repository URL: https://github.com/owner/repository, without credentials, query, or fragment.');
    }
    return `https://github.com/${parts.join('/').toLowerCase()}`;
  }
  function repositories(value) {
    if (value == null) value = [];
    if (!Array.isArray(value)) throw new Error('Public repositories must be a list of HTTPS repository URLs.');
    if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_BYTES) throw new Error('Repository links exceed the 16 KB profile budget. Shorten the selection before publishing.');
    const result = value.map(repository);
    if (new Set(result).size !== result.length) throw new Error('Remove duplicate repository links.');
    return result;
  }
  function validate(raw) {
    if (!raw || raw.format !== 'decentcanopy-creator' || ![1, 2].includes(raw.version) || raw.consent !== true) throw new Error('A version 1 or 2 creator record with public-publication consent is required.');
    const v2 = raw.version === 2;
    if (!/^0x[0-9a-fA-F]{40}$/.test(raw.wallet || '') || /^0x0{40}$/i.test(raw.wallet)) throw new Error('A non-zero wallet address is required.');
    const signer = raw.wallet.toLowerCase();
    if (!Number.isSafeInteger(raw.revision) || raw.revision < 1) throw new Error('Revision must be a positive integer.');
    if (raw.revision === 1 ? raw.previousCid !== null : !CID.test(raw.previousCid || '')) throw new Error('Revision must reference its previous IPFS CID (null for the first revision).');
    if (typeof raw.updatedAt !== 'string' || !Number.isFinite(Date.parse(raw.updatedAt))) throw new Error('A valid update timestamp is required.');
    const projects = rows(raw.projects, 'Projects', 20).map(p => {
      const project = {
        key: key(p.key), name: text(p.name, 'Project name', 100), description: text(p.description, 'Project description', 1200, true),
        website: url(p.website), image: url(p.image),
        status: choice(p.status, ['planning', 'active', 'paused', 'completed'], 'project status'),
        archiveId: text(p.archiveId, 'Historical reference', 120, true),
      };
      if (p.ens != null && p.ens !== '') {
        if (!v2) throw new Error('Project ENS names require a version 2 record.');
        const ens = text(p.ens, 'ENS name', 255).toLowerCase();
        if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+eth$/.test(ens)) throw new Error('Enter an ASCII ENS name ending in .eth, without a URL.');
        project.ens = ens;
      }
      if (v2) Object.assign(project, { wallet: address(p.wallet, 'Project receiving wallet'), related: refs(p.related, 'project', 'Related Decent projects', 10) });
      if (p.repositories != null) {
        if (!v2) throw new Error('Repository links require a version 2 record.');
        const links = repositories(p.repositories);
        if (links.length) project.repositories = links;
      }
      return project;
    });
    if (new Set(projects.map(p => p.key)).size !== projects.length) throw new Error('Project keys must be unique.');
    if (projects.some(p => p.archiveId && !/^(artizen-project|curated-project):[^<>"\s]+$/.test(p.archiveId))) throw new Error('Historical references must identify an archived project.');
    const known = new Set(projects.map(p => p.key));
    function ownRef(ref, kind, keys) {
      const [type, wallet, refKey] = ref.split(':');
      if (type !== `decent-${kind}` || wallet !== signer) return null;
      if (!keys.has(refKey)) throw new Error(`A link references a missing ${kind} in your own record.`);
      return refKey;
    }
    projects.forEach(p => (p.related || []).forEach(ref => {
      if (ownRef(ref, 'project', known) === p.key) throw new Error('A project cannot be related to itself.');
    }));
    function projectKey(value) {
      if (!value) return '';
      if (!known.has(value)) throw new Error('A journey or funding entry references a missing project.');
      return value;
    }
    const funds = !v2 ? null : rows(raw.funds == null ? [] : raw.funds, 'Decent funds', 10).map(f => ({
      key: key(f.key), name: text(f.name, 'Fund name', 100), description: text(f.description, 'Fund description', 1200, true),
      website: url(f.website), image: url(f.image),
      status: choice(f.status, ['open', 'invite-only', 'paused', 'closed'], 'fund status'),
      treasury: f.treasury == null || (!f.treasury.address && !f.treasury.chain) ? null
        : { chain: choice(f.treasury.chain, CHAINS, 'treasury chain'), address: address(f.treasury.address, 'Fund treasury', false) },
      supports: refs(f.supports, 'project', 'Supported Decent projects', 30),
    }));
    if (funds && new Set(funds.map(f => f.key)).size !== funds.length) throw new Error('Fund keys must be unique.');
    const fundKeys = new Set((funds || []).map(f => f.key));
    (funds || []).forEach(f => f.supports.forEach(ref => ownRef(ref, 'project', known)));
    const funding = rows(raw.funding, 'Funding sources', 30).map(f => {
      const entry = {
        key: key(f.key), name: text(f.name, 'Funding source', 100), projectKey: projectKey(f.projectKey),
        website: url(f.website), status: choice(f.status, ['exploring', 'applied', 'pledged', 'received', 'ended'], 'funding status'),
        amount: amount(f.amount), currency: text(f.currency, 'Currency', 12, true),
        asOf: date(f.asOf), note: text(f.note, 'Funding note', 600, true),
      };
      if (v2) {
        entry.fundRef = f.fundRef ? refs([f.fundRef], 'fund', 'Decent fund', 1)[0] : '';
        if (entry.fundRef) ownRef(entry.fundRef, 'fund', fundKeys);
        entry.chain = f.chain ? choice(f.chain, CHAINS, 'payment chain') : '';
        if (f.txHash && !/^0x[0-9a-fA-F]{64}$/.test(f.txHash)) throw new Error('Transaction hash must be 0x followed by 64 hex characters.');
        entry.txHash = f.txHash ? f.txHash.toLowerCase() : '';
        if (entry.txHash && (!entry.chain || !entry.fundRef)) throw new Error('A payment transaction needs its chain and the Decent fund that sent it.');
      }
      return entry;
    });

    if (new Set(funding.map(f => f.key)).size !== funding.length) throw new Error('Funding keys must be unique.');
    if (funding.some(f => f.amount !== null && !f.currency)) throw new Error('An amount requires a currency.');
    const journey = rows(raw.journey, 'Journey updates', 40).map(j => ({
      key: key(j.key), date: date(j.date), projectKey: projectKey(j.projectKey),
      type: choice(j.type, ['progress', 'milestone', 'artizen-experience'], 'journey type'),
      note: text(j.note, 'Journey update', 1200), evidence: url(j.evidence),
      payout: j.type === 'artizen-experience'
        ? choice(j.payout, ['not-shared', 'received', 'partially-received', 'not-received', 'uncertain', 'not-applicable'], 'self-reported payout status')
        : 'not-shared',
    }));
    if (new Set(journey.map(j => j.key)).size !== journey.length) throw new Error('Journey keys must be unique.');
    const location = raw.location == null ? null : {
      label: text(raw.location.label, 'Location', 120),
      precision: choice(raw.location.precision, ['country', 'city'], 'location precision'),
      consent: raw.location.consent === true,
    };
    if (location && !location.consent) throw new Error('Sharing a location requires explicit consent.');
    if (raw.rabbitHole != null && typeof raw.rabbitHole !== 'boolean') throw new Error('Rabbit Hole opt-in must be true or false.');
    if (raw.rabbitHole === true && !v2) throw new Error('Rabbit Hole rooms require a version 2 record.');
    const result = {
      format: 'decentcanopy-creator', version: raw.version, consent: true, wallet: signer,
      revision: raw.revision, previousCid: raw.previousCid, updatedAt: new Date(raw.updatedAt).toISOString(),
      name: text(raw.name, 'Creator name', 100), bio: text(raw.bio, 'Bio', 1200, true),
      website: url(raw.website), avatar: url(raw.avatar), location, projects, ...(v2 ? { funds } : {}), funding, journey,
      ...(raw.rabbitHole === true ? { rabbitHole: true } : {}),
    };
    if (new TextEncoder().encode(JSON.stringify(result)).length > MAX_BYTES) throw new Error('This profile exceeds 16 KB. Shorten notes or repository selections, or export older updates separately.');
    return result;
  }
  function message(record) { return PREFIX + JSON.stringify(validate(record)); }
  function parse(value) {
    if (typeof value !== 'string' || !value.startsWith(PREFIX) || new TextEncoder().encode(value).length > MAX_BYTES + 100) throw new Error('Not a valid DecentCanopy creator publication.');
    const record = validate(JSON.parse(value.slice(PREFIX.length)));
    if (message(record) !== value) throw new Error('Creator message is not in canonical format.');
    return record;
  }
  function verify(envelope, verifyMessage) {
    if (!envelope || !/^0x[0-9a-fA-F]{130}$/.test(envelope.signature || '')) throw new Error('A wallet signature is required.');
    const record = parse(envelope.message);
    if (String(verifyMessage(envelope.message, envelope.signature)).toLowerCase() !== record.wallet) throw new Error('Signature does not authorize this wallet profile.');
    return record;
  }
  function assertNext(record, existing) {
    if (existing && record.revision === existing.record.revision && message(record) === existing.message) return 'duplicate';
    if (record.revision !== (existing ? existing.record.revision + 1 : 1)
      || record.previousCid !== (existing ? existing.cid : null)) throw new Error('Your profile has a newer published version. Reload it before signing again.');
    return 'next';
  }
  function apply(base, entries) {
    const projects = base.projects.slice(), associations = base.associations.slice();
    const archiveById = new Map(base.projects.map(p => [p.id, p]));
    const known = new Set(projects.map(p => p.id)), owners = new Map(), claims = new Map();
    const repositoryNodes = new Map();
    const link = (source, target, type, note) => associations.push({ source, target, type, note, sourceLabel: 'Wallet-signed self-report' });
    const commonFor = entry => ({ sourceLabel: entry.draft ? 'Browser-local creator draft · not public' : 'Wallet-signed creator report · not independently verified', raised: 0, goal: 0, creatorRecord: entry.record, creatorCid: entry.cid, creatorSignature: entry.signature, creatorMessage: entry.message, creatorDraft: Boolean(entry.draft) });
    entries.forEach(entry => {
      const r = entry.record, creatorId = `decent-creator:${r.wallet}`, common = commonFor(entry);
      const add = node => { projects.push({ ...common, ...node }); owners.set(node.id, { wallet: r.wallet, name: node.name, kind: node.kind }); };
      add({ id: creatorId, name: r.name, kind: 'creator', track: 'Creators', status: 'active', description: r.bio, websiteUrl: r.website, image: r.avatar, publicWallet: { address: r.wallet, chainId: 8453 }, sharedLocation: r.location });
      r.projects.forEach(p => {
        const id = `decent-project:${r.wallet}:${p.key}`;
        const projectDetails = archiveById.get(p.archiveId)?.projectDetails || null;
        add({ id, name: p.name, kind: 'project', track: 'Projects', status: p.status, description: p.description, websiteUrl: p.website, image: p.image, creatorProjectKey: p.key,
          ...(projectDetails ? { projectDetails, raised: projectDetails.raised, goal: projectDetails.goal } : {}) });
        link(creatorId, id, 'creator-associated', 'Project association claimed by this wallet; not independently verified ownership.');
        (p.repositories || []).forEach(repoUrl => {
          const fullName = repoUrl.slice('https://github.com/'.length), repoId = `github-repo:${fullName}`;
          if (!repositoryNodes.has(repoId)) {
            const repositoryNode = {
              ...common, id: repoId, kind: 'repository', track: 'Repositories', status: 'not-reported',
              name: fullName, repoUrl, raised: null, goal: null,
              description: 'Self-declared public repository association; GitHub identity, authorship, and ownership are not verified.',
              github: { fullName, url: repoUrl }
            };
            repositoryNodes.set(repoId, repositoryNode);
            projects.push(repositoryNode);
          }
          associations.push({
            source: id, target: repoId, type: 'repository-link',
            sourceLabel: entry.draft ? 'Browser-local self-declared repository link' : 'Wallet-signed self-declared repository link',
            note: 'Discovery link only; not GitHub account verification, ownership, affiliation, endorsement, or proof of contribution.',
            decentClaim: 'claimed'
          });
        });
        if (p.archiveId && known.has(p.archiveId)) link(id, p.archiveId, 'research-link', 'Creator-reported historical reference; the archive remains unchanged.');
      });
      (r.funds || []).forEach(f => {
        const id = `decent-fund:${r.wallet}:${f.key}`;
        add({ id, name: f.name, kind: 'fund', track: 'Funds', status: f.status, description: f.description, websiteUrl: f.website, image: f.image, creatorFundKey: f.key, available: null });
        link(creatorId, id, 'fund-steward', 'Fund published and stewarded by this wallet.');
      });
    });
    function claim(source, target, type, wallet, ledger) {
      if (!owners.has(source) || !owners.has(target)) return;
      if (type === 'collaboration' && source > target) [source, target] = [target, source];
      const id = `${type}|${source}|${target}`;
      if (!claims.has(id)) claims.set(id, { source, target, type, claimedBy: new Set(), ledgerCandidates: [] });
      const row = claims.get(id);
      row.claimedBy.add(wallet);
      if (ledger) row.ledgerCandidates.push(ledger);
    }
    entries.forEach(entry => {
      const r = entry.record, creatorId = `decent-creator:${r.wallet}`, projectId = k => `decent-project:${r.wallet}:${k}`;
      r.projects.forEach(p => (p.related || []).forEach(ref => claim(projectId(p.key), ref, 'collaboration', r.wallet)));
      (r.funds || []).forEach(f => f.supports.forEach(ref => claim(ref, `decent-fund:${r.wallet}:${f.key}`, 'funding-pool', r.wallet)));
      r.funding.forEach(f => {
        const source = f.projectKey ? projectId(f.projectKey) : creatorId;
        if (f.fundRef && owners.has(f.fundRef)) {
          const fundOwner = owners.get(f.fundRef).wallet;
          const fund = entries.find(e => e.record.wallet === fundOwner).record.funds.find(x => `decent-fund:${fundOwner}:${x.key}` === f.fundRef);
          const recipient = (f.projectKey && r.projects.find(p => p.key === f.projectKey).wallet) || r.wallet;
          const ledger = f.txHash && fund.treasury && fund.treasury.chain === f.chain ? {
            chain: f.chain, txHash: f.txHash, treasury: fund.treasury.address, recipient,
            treasurySigned: fund.treasury.address === fundOwner, recipientSigned: recipient === r.wallet, fundingKey: f.key,
          } : null;
          claim(source, f.fundRef, 'funding-pool', r.wallet, ledger);
          return;
        }
        const id = `decent-source:${r.wallet}:${f.key}`;
        projects.push({ ...commonFor(entry), id, name: f.name, kind: 'fund', track: 'Funds', status: 'not-reported', description: `${f.status} · ${f.note}`, websiteUrl: f.website, creatorFundingKey: f.key, available: null });
        link(source, id, 'funding-pool', `Self-reported ${f.status}; not fund membership, endorsement or a verified payout.`);
      });
    });
    claims.forEach(row => {
      const sides = [owners.get(row.source).wallet, owners.get(row.target).wallet];
      const mutual = sides.every(w => row.claimedBy.has(w));
      const subject = row.type === 'funding-pool' ? 'Funding relationship' : 'Project relationship';
      associations.push({
        source: row.source, target: row.target, type: row.type, sourceLabel: 'Wallet-signed self-report',
        decentClaim: mutual ? 'mutual' : 'claimed', claimedBy: [...row.claimedBy], ledgerCandidates: row.ledgerCandidates,
        note: mutual ? `${subject} confirmed by the wallets on both sides.` : `${subject} claimed by one side only; not confirmed by the other wallet.`,
      });
    });
    return { ...base, projects, associations };
  }
  function replaceProject(record, project) {
    if (!record.projects.some(p => p.key === project.key)) throw new Error('This project is no longer in your profile. Reopen your latest profile before editing.');
    return validate({ ...record, projects: record.projects.map(p => p.key === project.key ? project : p) });
  }
  const api = { validate, message, parse, verify, assertNext, apply, replaceProject, repository, repositories, CID, MAX_BYTES, CHAINS, REF };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DecentCreatorRecords = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
