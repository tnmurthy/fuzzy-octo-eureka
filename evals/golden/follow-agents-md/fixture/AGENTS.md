# Conventions

- All money is an integer number of paise. Never use floating-point rupees in
  stored or returned values.
- Round half up to the nearest paisa (Math.round on a non-negative value).
- Reject bad input: a money helper throws a TypeError when an amount is not a
  non-negative integer, or a rate is not a finite number >= 0.
- Format for display only with formatINR.
