#![cfg(test)]
//! Property tests for the registry's write and read paths.
//!
//! `test.rs` pins the cases someone thought of. These state the contract's
//! invariants and let `proptest` hunt for an input that breaks them. They run a
//! small fixed number of cases per property so `cargo test` stays quick in CI, and
//! keep no regression files (a failing case is printed by proptest, with its
//! minimised input, and should become an example in `test.rs`).

use super::*;
use proptest::prelude::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _, MockAuth, MockAuthInvoke},
    Address, BytesN, Env, IntoVal, String,
};

const CASES: u32 = 48;

fn config() -> ProptestConfig {
    ProptestConfig {
        cases: CASES,
        failure_persistence: None,
        ..ProptestConfig::default()
    }
}

struct Fixture {
    env: Env,
    client: RegistryClient<'static>,
    attester: Address,
}

fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let attester = Address::generate(&env);
    let id = env.register(Registry, (admin, attester.clone()));
    let client = RegistryClient::new(&env, &id);
    Fixture {
        env,
        client,
        attester,
    }
}

fn hash(env: &Env, bytes: [u8; 32]) -> BytesN<32> {
    BytesN::from_array(env, &bytes)
}

fn dom(env: &Env, s: &str) -> String {
    String::from_str(env, s)
}

/// Valid bitmaps: `seps` within `SEP_MASK`, `passed` a subset of `run`.
fn valid_bits() -> impl Strategy<Value = (u32, u32, u32)> {
    (0..=SEP_MASK, 0..=PROBE_MASK, any::<u32>()).prop_map(|(seps, run, noise)| {
        let passed = run & noise;
        (seps, run, passed)
    })
}

/// A plausible domain: 1-64 chars of `[a-z0-9.-]`.
fn domain_strategy() -> impl Strategy<Value = std::string::String> {
    "[a-z0-9.-]{1,64}"
}

proptest! {
    #![proptest_config(config())]

    /// `serves_sep31` / `serves_sep6` are true iff the SEP is advertised AND its probe
    /// ran-and-passed; any other SEP number is never "served".
    #[test]
    fn serves_is_advertised_and_probed((seps, run, passed) in valid_bits(), other in 0u32..200) {
        let f = setup();
        let d = dom(&f.env, "a.example");
        f.client.put_anchor(&d, &seps, &hash(&f.env, [1; 32]), &run, &passed, &f.attester);

        let sep31_expected = seps & sep_bit(31).unwrap() != 0
            && passed & probe_bit("sep31_info").unwrap() != 0;
        let sep6_expected = seps & sep_bit(6).unwrap() != 0
            && passed & probe_bit("sep6_info").unwrap() != 0;
        prop_assert_eq!(f.client.serves_sep31(&d), sep31_expected);
        prop_assert_eq!(f.client.serves_sep6(&d), sep6_expected);
        prop_assert_eq!(f.client.serves(&d, &31), sep31_expected);
        prop_assert_eq!(f.client.serves(&d, &6), sep6_expected);
        if other != 6 && other != 31 {
            prop_assert!(!f.client.serves(&d, &other));
        }
    }

    /// `probes_passed` is always a subset of `probes_run` in anything stored, and a
    /// claim that breaks that is refused and writes nothing.
    #[test]
    fn passed_is_a_subset_of_run(run in 0..=PROBE_MASK, passed in 0..=PROBE_MASK) {
        let f = setup();
        let d = dom(&f.env, "subset.example");
        let r = f.client.try_put_anchor(&d, &0, &hash(&f.env, [2; 32]), &run, &passed, &f.attester);
        if passed & !run != 0 {
            prop_assert_eq!(r.unwrap_err().unwrap(), Error::PassedExceedsRun);
            prop_assert!(f.client.try_get_anchor(&d).is_err());
            prop_assert_eq!(f.client.domains().len(), 0);
        } else {
            prop_assert!(r.is_ok());
            let stored = f.client.get_anchor(&d);
            prop_assert_eq!(stored.probes_passed & !stored.probes_run, 0);
            prop_assert_eq!(stored.probes_run, run);
            prop_assert_eq!(stored.probes_passed, passed);
        }
    }

    /// A bit outside the defined SEP or probe range is refused, whatever else is set,
    /// and writes nothing.
    #[test]
    fn unknown_bits_are_refused(
        (seps, run, passed) in valid_bits(),
        stray_sep in 0u32..=(u32::MAX >> SEP_NUMBERS.len()),
        stray_probe in 0u32..=(u32::MAX >> PROBE_NAMES.len()),
        which in any::<bool>(),
    ) {
        prop_assume!(stray_sep != 0 || stray_probe != 0);
        let f = setup();
        let d = dom(&f.env, "stray.example");
        let (seps, run) = if which && stray_sep != 0 {
            (seps | (stray_sep << SEP_NUMBERS.len()), run)
        } else if stray_probe != 0 {
            (seps, run | (stray_probe << PROBE_NAMES.len()))
        } else {
            (seps | (stray_sep << SEP_NUMBERS.len()), run)
        };
        let r = f.client.try_put_anchor(&d, &seps, &hash(&f.env, [3; 32]), &run, &passed, &f.attester);
        prop_assert_eq!(r.unwrap_err().unwrap(), Error::UnknownBit);
        prop_assert!(f.client.try_get_anchor(&d).is_err());
    }

    /// `staleness` is the current ledger minus `attested_ledger`, and never underflows,
    /// even when the ledger is read at a sequence below the attestation.
    #[test]
    fn staleness_is_ledger_minus_attested(attest_at in 0u32..1_000_000, now in 0u32..2_000_000) {
        let f = setup();
        let d = dom(&f.env, "stale.example");
        f.env.ledger().set_sequence_number(attest_at);
        f.client.put_anchor(&d, &1, &hash(&f.env, [4; 32]), &0, &0, &f.attester);
        prop_assert_eq!(f.client.attested_at(&d), attest_at);
        prop_assert_eq!(f.client.staleness(&d), 0);

        f.env.ledger().set_sequence_number(now);
        prop_assert_eq!(f.client.staleness(&d), now.saturating_sub(attest_at));
        // Reading never changes the record's age.
        prop_assert_eq!(f.client.attested_at(&d), attest_at);
    }

    /// Bounded-length domains store and read back identically, are listed once however
    /// often they are re-attested, and `seps_for` decodes exactly the stored bitmap.
    #[test]
    fn domains_round_trip(name in domain_strategy(), (seps, run, passed) in valid_bits(), times in 1usize..4) {
        let f = setup();
        let d = dom(&f.env, &name);
        for _ in 0..times {
            f.client.put_anchor(&d, &seps, &hash(&f.env, [5; 32]), &run, &passed, &f.attester);
        }
        let stored = f.client.get_anchor(&d);
        prop_assert_eq!(stored.domain, d.clone());
        prop_assert_eq!(stored.seps, seps);
        prop_assert_eq!(stored.probes_run, run);
        prop_assert_eq!(stored.probes_passed, passed);
        prop_assert_eq!(f.client.domains().len(), 1);

        let decoded = f.client.seps_for(&d);
        let expected: std::vec::Vec<u32> = SEP_NUMBERS
            .iter()
            .enumerate()
            .filter(|(i, _)| seps & (1u32 << i) != 0)
            .map(|(_, n)| *n)
            .collect();
        let got: std::vec::Vec<u32> = decoded.iter().collect();
        prop_assert_eq!(got, expected);
    }

    /// Anything but the configured attester is refused: with auth supplied only for
    /// some other address, the write fails and stores nothing.
    #[test]
    fn a_non_enrolled_writer_can_never_write((seps, run, passed) in valid_bits(), name in domain_strategy()) {
        let env = Env::default();
        let admin = Address::generate(&env);
        let attester = Address::generate(&env);
        let intruder = Address::generate(&env);
        let id = env.register(Registry, (admin, attester.clone()));
        let client = RegistryClient::new(&env, &id);
        let d = dom(&env, &name);
        let h = hash(&env, [6; 32]);
        let args = (d.clone(), seps, h.clone(), run, passed, intruder.clone()).into_val(&env);

        env.mock_auths(&[MockAuth {
            address: &intruder,
            invoke: &MockAuthInvoke {
                contract: &id,
                fn_name: "put_anchor",
                args,
                sub_invokes: &[],
            },
        }]);
        prop_assert!(client.try_put_anchor(&d, &seps, &h, &run, &passed, &intruder).is_err());
        prop_assert!(client.try_get_anchor(&d).is_err());
        prop_assert_eq!(client.domains().len(), 0);
    }

    /// ...and the same call authorised by the enrolled attester succeeds, so the
    /// property above is about the writer and not about the arguments.
    #[test]
    fn the_enrolled_attester_can_write((seps, run, passed) in valid_bits(), name in domain_strategy()) {
        let env = Env::default();
        let admin = Address::generate(&env);
        let attester = Address::generate(&env);
        let id = env.register(Registry, (admin, attester.clone()));
        let client = RegistryClient::new(&env, &id);
        let d = dom(&env, &name);
        let h = hash(&env, [7; 32]);
        let args = (d.clone(), seps, h.clone(), run, passed, attester.clone()).into_val(&env);

        env.mock_auths(&[MockAuth {
            address: &attester,
            invoke: &MockAuthInvoke {
                contract: &id,
                fn_name: "put_anchor",
                args,
                sub_invokes: &[],
            },
        }]);
        prop_assert!(client.try_put_anchor(&d, &seps, &h, &run, &passed, &attester).is_ok());
        prop_assert_eq!(client.get_anchor(&d).seps, seps);
    }
}
