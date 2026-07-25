/**
 * The Stelic mark, inlined as vector (taken from the mark on stelic.com).
 *
 * Inlined rather than referenced as a file for three reasons: it renders crisp at every size
 * including a 20px header, it costs no request — so the installed PWA shows it offline, on
 * the very first paint, with no layout shift — and it survives a strict content policy that
 * blocks remote images.
 *
 * The mark, not the wordmark. Stelic's wordmark is white on transparent, made for the dark
 * hero on their site; on this app's light background it would be invisible. The mark carries
 * its own navy field, so it reads correctly on either theme without a second asset.
 *
 * Decorative by default: wherever it appears it sits beside the words "Stelic Assistant", and
 * a screen reader announcing the name twice is worse than not announcing the logo. Pass a
 * `title` where it stands alone.
 */
export function StelicMark({
  size = 40,
  title,
  className,
}: {
  size?: number
  title?: string
  className?: string
}) {
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={className}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      {/* The rounded square is a clip, not a border-radius: the accent band at the foot has
          to be cut by the same corner curve as the navy field behind it. */}
      <clipPath id="stelic-mark-clip">
        <rect width="100" height="100" rx="22.5" />
      </clipPath>
      <g clipPath="url(#stelic-mark-clip)">
        <rect width="100" height="100" fill="#0b204b" />
        <g transform="translate(35.694 16.5) scale(0.25592)">
          <path
            d="M568.477 587.25C442.148 587.25 327.223 615.91 223.672 673.219 120.141 730.512 48.8477 805.41 9.76172 897.859 3.25781 913.512 0 926.52 0 936.949 0 956.469 7.15234 973.719 21.4844 988.699 35.8086 1003.69 55.3555 1013.78 80.0859 1019 84.0117 1020.28 90.5156 1020.93 99.6289 1020.93 120.465 1020.93 140.332 1014.75 159.203 1002.38 178.102 990.012 192.109 973.398 201.219 952.57 224.664 901.789 270.902 858.801 339.91 823.629 408.945 788.469 485.133 770.891 568.477 770.891 666.141 770.891 748.855 793.359 816.578 838.289 884.297 883.211 918.168 944.75 918.168 1022.9 918.168 1097.12 889.512 1160.62 832.195 1213.36 774.906 1266.11 687.645 1298.34 570.434 1310.06 408.945 1325.68 281.953 1372.91 189.504 1451.68 97.0273 1530.48 50.7852 1629.14 50.7852 1747.66 50.7852 1831 74.5508 1902.97 122.105 1963.51 169.633 2024.08 234.746 2070.32 317.441 2102.23 400.156 2134.11 492.934 2150.08 595.816 2150.08 707.836 2150.08 802.25 2127.28 879.082 2081.71 955.918 2036.13 1021.05 1971.01 1074.44 1886.36 1090.06 1861.6 1097.89 1838.16 1097.89 1816.03 1097.89 1787.38 1084.85 1763.93 1058.82 1745.71 1044.49 1736.59 1027.56 1732.02 1008.01 1732.02 988.496 1732.02 970.242 1736.91 953.328 1746.67 936.395 1756.46 923.359 1769.79 914.242 1786.73 879.082 1845.34 835.125 1889.93 782.383 1920.55 729.637 1951.14 662.891 1966.44 582.156 1966.44 483.172 1966.44 403.086 1947.25 341.875 1908.83 280.664 1870.39 250.043 1814.71 250.043 1741.8 250.043 1674.06 277.406 1617.42 332.09 1571.82 386.797 1526.26 484.469 1496.3 625.117 1481.98 781.418 1466.34 902.523 1419.13 988.496 1340.34 1074.44 1261.56 1117.43 1157.69 1117.43 1028.75 1117.43 934.98 1092.02 854.582 1041.24 787.5 990.434 720.43 923.035 670.289 839.027 637.07 755.043 603.871 664.848 587.25 568.477 587.25"
            transform="matrix(.1,0,0,-.1,0,215.2)"
            fill="#ffffff"
            stroke="#ffffff"
            strokeWidth="170"
            strokeLinejoin="round"
            strokeLinecap="round"
            fillRule="evenodd"
          />
        </g>
        <rect y="87" width="100" height="13" fill="#009be3" />
      </g>
    </svg>
  )
}
