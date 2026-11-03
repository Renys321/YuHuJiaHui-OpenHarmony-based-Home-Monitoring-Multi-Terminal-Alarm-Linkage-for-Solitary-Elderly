import sys

a = open(sys.argv[1], 'rb').read()
b = open(sys.argv[2], 'rb').read()
print('len_a=%d len_b=%d' % (len(a), len(b)))
n = min(len(a), len(b))
runs = []
i = 0
while i < n:
    if a[i] != b[i]:
        j = i
        while j < n and a[j] != b[j]:
            j += 1
        runs.append((i, j))
        i = j
    else:
        i += 1
print('diff_runs=%d total_bytes=%d' % (len(runs), sum(j - i for i, j in runs)))
for i, j in runs[:20]:
    print('  0x%06x..0x%06x (%d B)' % (i, j, j - i))
    print('    old=%s' % a[i:min(j, i + 32)].hex())
    print('    new=%s' % b[i:min(j, i + 32)].hex())
