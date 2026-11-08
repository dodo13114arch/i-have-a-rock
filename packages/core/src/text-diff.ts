export interface DiffLine {
	type: "same" | "removed" | "added";
	text: string;
}

/** Line diff (longest common subsequence). Notes are short, so O(n·m) is fine. */
export function diffLines(before: string[], after: string[]): DiffLine[] {
	const n = before.length;
	const m = after.length;
	const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			lcs[i]![j] = before[i] === after[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
		}
	}
	const result: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (before[i] === after[j]) {
			result.push({ type: "same", text: before[i]! });
			i++;
			j++;
		} else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
			result.push({ type: "removed", text: before[i++]! });
		} else {
			result.push({ type: "added", text: after[j++]! });
		}
	}
	while (i < n) result.push({ type: "removed", text: before[i++]! });
	while (j < m) result.push({ type: "added", text: after[j++]! });
	return result;
}
