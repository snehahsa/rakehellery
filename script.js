const mottos = [
  "Entry fee is $30 worth of tokens — send any tiny amount to a seat; the contract burns the full $30 from your balance.",
  "You must send to 0x…0001–0006. Sending to 0x…0000 does not claim a seat.",
  "Winners are not drawn on the 6th entry. A Uniswap buy/sell ≥ $60 (2× entry) settles the game.",
  "2× means that one trade’s USD size — not market cap doubling.",
  "6 × $30 pool: 1st gets $100, 2nd gets $30, $50 stays burned.",
  "One wallet can take only one seat per game.",
  "The first player locks the token amount for the $30 entry for everyone at that table.",
];

const motto = document.querySelector("#motto");
const newMotto = document.querySelector("#new-motto");
let mottoIndex = 0;

newMotto?.addEventListener("click", () => {
  mottoIndex = (mottoIndex + 1) % mottos.length;
  motto.animate(
    [
      { opacity: 1, transform: "translateY(0)", filter: "blur(0)" },
      { opacity: 0, transform: "translateY(-6px)", filter: "blur(3px)" },
      { opacity: 0, transform: "translateY(6px)", filter: "blur(3px)" },
      { opacity: 1, transform: "translateY(0)", filter: "blur(0)" },
    ],
    { duration: 460, easing: "ease-out" },
  );
  window.setTimeout(() => {
    motto.textContent = mottos[mottoIndex];
  }, 210);
});

const reduceMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)",
).matches;

const inkCursor = document.querySelector(".ink-cursor");

if (window.matchMedia("(pointer: fine)").matches && inkCursor) {
  document.addEventListener("mousemove", (event) => {
    inkCursor.style.left = `${event.clientX}px`;
    inkCursor.style.top = `${event.clientY}px`;
    inkCursor.style.opacity = "1";
  });

  document.addEventListener("mouseleave", () => {
    inkCursor.style.opacity = "0";
  });
}

// Assign scroll-reveal treatments to page elements.
const revealPlan = [
  [".sheet-section .section-number", "up"],
  [".sheet-section .ornament", "scale"],
  [".sheet-section h2", "up"],
  [".columns p:first-child", "left"],
  [".columns p:last-child", "right"],
  [".dark-section .section-number", "up"],
  [".stats-heading", "scale"],
  [".led-sub", "up"],
  [".game-grid article", "up"],
  [".payout-ledger > div", "up"],
  [".covenant-kicker", "up"],
  [".fine-print", "up"],
  [".chronicle .section-intro", "up"],
  [".tally", "up"],
  [".motto-box", "scale"],
  [".roadmap .section-intro", "up"],
  [".phase", "up"],
  [".summon svg", "scale"],
  [".summon h2", "up"],
  [".summon-inner > p:not(.eyebrow)", "up"],
  [".summon-actions", "up"],
];

const revealElements = [];
revealPlan.forEach(([selector, direction]) => {
  document.querySelectorAll(selector).forEach((el, index) => {
    el.setAttribute("data-reveal", direction);
    if (index > 0) {
      el.classList.add(`reveal-delay-${Math.min(index, 3)}`);
    }
    revealElements.push(el);
  });
});

const countTargets = document.querySelectorAll(".ledger-value");

function runCountUp(el) {
  const target = parseInt(el.textContent, 10);
  if (Number.isNaN(target)) return;
  const duration = 1100;
  const start = performance.now();
  function tick(now) {
    const progress = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.round(target * eased).toString();
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

if (reduceMotion) {
  revealElements.forEach((el) => el.classList.add("is-visible"));
} else {
  const revealObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        revealObserver.unobserve(entry.target);
      });
    },
    { threshold: 0.18, rootMargin: "0px 0px -8% 0px" },
  );
  revealElements.forEach((el) => revealObserver.observe(el));

  const countObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        runCountUp(entry.target);
        countObserver.unobserve(entry.target);
      });
    },
    { threshold: 0.6 },
  );
  countTargets.forEach((el) => countObserver.observe(el));
}

// Scroll progress bar + parallax, batched into a single rAF loop.
const progressBar = document.querySelector(".ink-progress i");
const blots = Array.from(document.querySelectorAll(".ink-blot"));
let ticking = false;

function onScroll() {
  const scrollTop = window.scrollY;
  const docHeight = document.documentElement.scrollHeight - window.innerHeight;
  const progress = docHeight > 0 ? scrollTop / docHeight : 0;

  if (progressBar) {
    progressBar.style.transform = `scaleX(${progress})`;
  }

  if (!reduceMotion) {
    blots.forEach((blot, i) => {
      const speed = 0.12 + i * 0.06;
      blot.style.transform = `translateY(${-scrollTop * speed}px)`;
    });
  }

  ticking = false;
}

window.addEventListener(
  "scroll",
  () => {
    if (!ticking) {
      window.requestAnimationFrame(onScroll);
      ticking = true;
    }
  },
  { passive: true },
);

onScroll();
