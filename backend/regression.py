"""Tiny OLS fitter — no numpy. Solves β for `y = β0 + β1·x1 + β2·x2 + …`
using the normal equations, with a Gauss-Jordan inverse on the (k+1)×(k+1)
covariance matrix. Sized for k ≤ 4 predictors and windows ≤ 1k rows; that's
all we ever feed it from the live rolling buffer."""

from typing import List, Sequence, Tuple


def fit_linear(target: Sequence[float], features: Sequence[Sequence[float]]
               ) -> Tuple[float, List[float], float]:
    """Returns (intercept, coefficients, r2).

    `features` is rows × k. `target` is length n. Both lengths must match.
    Falls back to a mean-only model if the system is singular."""
    n = len(target)
    if n == 0 or not features or len(features[0]) == 0:
        return 0.0, [], 0.0
    k = len(features[0])
    # Augment X with a leading 1-column for the intercept.
    X = [[1.0] + list(row) for row in features]
    y = list(target)

    # Build XtX (size (k+1)x(k+1)) and Xty (k+1)
    p = k + 1
    XtX = [[0.0] * p for _ in range(p)]
    Xty = [0.0] * p
    for i in range(n):
        xi = X[i]
        yi = y[i]
        for a in range(p):
            Xty[a] += xi[a] * yi
            for b in range(p):
                XtX[a][b] += xi[a] * xi[b]

    inv = _invert(XtX)
    if inv is None:
        # Singular — fall back to mean of target.
        m = sum(y) / n
        return m, [0.0] * k, 0.0

    beta = [sum(inv[a][b] * Xty[b] for b in range(p)) for a in range(p)]
    intercept = beta[0]
    coefs = beta[1:]

    # R² for diagnostics.
    mean_y = sum(y) / n
    ss_tot = sum((yi - mean_y) ** 2 for yi in y)
    ss_res = 0.0
    for i in range(n):
        pred = intercept + sum(coefs[j] * features[i][j] for j in range(k))
        ss_res += (y[i] - pred) ** 2
    r2 = 1.0 - (ss_res / ss_tot) if ss_tot > 1e-9 else 0.0
    return intercept, coefs, r2


def _invert(m: List[List[float]]) -> List[List[float]] | None:
    """Gauss-Jordan in-place. Returns None if singular."""
    n = len(m)
    a = [row[:] + [1.0 if i == j else 0.0 for j in range(n)] for i, row in enumerate(m)]
    for col in range(n):
        # Partial pivot.
        pivot = col
        for r in range(col, n):
            if abs(a[r][col]) > abs(a[pivot][col]):
                pivot = r
        if abs(a[pivot][col]) < 1e-12:
            return None
        if pivot != col:
            a[col], a[pivot] = a[pivot], a[col]
        # Normalize pivot row.
        pv = a[col][col]
        for c in range(2 * n):
            a[col][c] /= pv
        # Eliminate other rows.
        for r in range(n):
            if r == col:
                continue
            factor = a[r][col]
            if factor == 0.0:
                continue
            for c in range(2 * n):
                a[r][c] -= factor * a[col][c]
    return [row[n:] for row in a]
