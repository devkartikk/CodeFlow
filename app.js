(() => {
  'use strict';

  const state = {
    source: '',
    snapshot: '',
    step: 0,
    playing: false,
    timer: null,
    language: 'python',
    // Which worked example is loaded (null when the editor holds user code),
    // and which language the examples section is currently previewing.
    example: null,
    exampleLanguage: 'python',
    apiOnline: null,
    history: [],
    trace: [],
    diagnostics: [],
    lastResult: null,
    executedSource: '',
    activeLine: null,
    audioContext: null,
    soundEnabled: false,
    soundUnlocking: false,
    aiConfigured: false,
    explainToken: 0,
    stdinLines: [],
    lastOutput: [],
    // Terminal session state. termEntries is the rendered stream (inputs echoed
    // in green, program output, errors); termShown is the output the program
    // has already produced so a re-run can append only the new lines.
    termEntries: [],
    termShown: [],
    awaitingInput: false,
    termRunning: false
  };

  const $ = (id) => document.getElementById(id);
  const all = (selector) => Array.from(document.querySelectorAll(selector));

  function showToast(message) {
    const toast = $('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    window.clearTimeout(showToast.timeout);
    showToast.timeout = window.setTimeout(() => toast.classList.remove('show'), 3200);
  }

  function setText(id, value) {
    const element = $(id);
    if (element) element.textContent = value;
  }

  function audioContextConstructor() {
    return window.AudioContext || window.webkitAudioContext || null;
  }

  function setSoundStatus(message) {
    setText('sound-status', message);
  }

  function updateSoundControl() {
    const button = $('sound-toggle');
    if (!button) return;
    const supported = Boolean(audioContextConstructor());
    button.disabled = !supported || state.soundUnlocking;
    button.textContent = state.soundEnabled ? '🔊 Sound on' : '🔇 Sound off';
    button.setAttribute('aria-pressed', String(state.soundEnabled));
    button.title = state.soundEnabled ? 'Mute trace sounds' : 'Enable trace sounds';
  }

  function configureSoundSupport() {
    if (!audioContextConstructor()) {
      setSoundStatus('Audio unavailable in this browser');
      updateSoundControl();
      return;
    }
    setSoundStatus('Sound off · enable to hear trace steps');
    updateSoundControl();
  }

  function ensureAudioContext() {
    if (state.audioContext) return state.audioContext;
    const AudioContext = audioContextConstructor();
    if (!AudioContext) return null;
    try {
      state.audioContext = new AudioContext();
      return state.audioContext;
    } catch (_) {
      state.audioContext = null;
      return null;
    }
  }

  function disableSound(message) {
    state.soundEnabled = false;
    state.soundUnlocking = false;
    updateSoundControl();
    setSoundStatus(message);
  }

  async function toggleSound() {
    if (state.soundUnlocking) return;
    if (state.soundEnabled) {
      disableSound('Sound off · enable to hear trace steps');
      return;
    }
    const context = ensureAudioContext();
    if (!context) {
      disableSound('Audio unavailable in this browser');
      return;
    }
    state.soundUnlocking = true;
    updateSoundControl();
    setSoundStatus('Enabling sound…');
    try {
      if (context.state === 'suspended') await context.resume();
      if (context.state === 'closed') throw new Error('AudioContext is closed');
      state.soundEnabled = true;
      setSoundStatus('Sound on · trace steps enabled');
    } catch (_) {
      disableSound('Sound could not start in this browser');
    } finally {
      state.soundUnlocking = false;
      updateSoundControl();
    }
  }

  function playStepSound(event) {
    if (!state.soundEnabled || !state.audioContext) return;
    const context = state.audioContext;
    if (context.state === 'closed') {
      disableSound('Sound unavailable in this browser');
      return;
    }
    if (context.state === 'suspended') {
      context.resume().catch(() => disableSound('Sound paused by the browser'));
      return;
    }
    const type = eventType(event).toLowerCase();
    const profile = type.includes('exception') || type.includes('error')
      ? { frequency: 180, duration: 0.14, waveform: 'sawtooth' }
      : type.includes('stdout') || type.includes('output')
        ? { frequency: 660, duration: 0.1, waveform: 'sine' }
        : type.includes('call')
          ? { frequency: 440, duration: 0.11, waveform: 'triangle' }
          : type.includes('return')
            ? { frequency: 275, duration: 0.11, waveform: 'triangle' }
            : { frequency: 350, duration: 0.09, waveform: 'sine' };
    try {
      const now = context.currentTime;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = profile.waveform;
      oscillator.frequency.setValueAtTime(profile.frequency, now);
      oscillator.frequency.linearRampToValueAtTime(profile.frequency * 0.98, now + profile.duration);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.035, now + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + profile.duration);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(now);
      oscillator.stop(now + profile.duration + 0.01);
      oscillator.addEventListener('ended', () => {
        oscillator.disconnect();
        gain.disconnect();
      }, { once: true });
    } catch (_) {
      disableSound('Sound could not play in this browser');
    }
  }

  const FILE_NAMES = { python: 'main.py', javascript: 'main.js', java: 'Main.java', c: 'main.c', cpp: 'main.cpp' };
  const LANGUAGE_LABELS = { python: 'Python', javascript: 'JavaScript', java: 'Java', c: 'C', cpp: 'C++' };

  // Shown when a language is chosen and the editor still holds an untouched
  // starter. Switching languages used to change only a label, which looks
  // exactly like nothing happened.
  const STARTERS = {
    python: 'def greet(name):\n    message = f"Hello, {name}!"\n    return message\n\nname = "world"\nresult = greet(name)\nprint(result)',
    javascript: 'function greet(name) {\n  const message = `Hello, ${name}!`;\n  return message;\n}\n\nconst name = "world";\nconst result = greet(name);\nconsole.log(result);',
    java: 'public class Main {\n    static String greet(String name) {\n        return "Hello, " + name + "!";\n    }\n\n    public static void main(String[] args) {\n        String result = greet("world");\n        System.out.println(result);\n    }\n}',
    c: '#include <stdio.h>\n\nint add(int a, int b) {\n    return a + b;\n}\n\nint main(void) {\n    int total = add(4, 7);\n    printf("Total is %d\\n", total);\n    return 0;\n}',
    cpp: '#include <iostream>\nusing namespace std;\n\nint add(int a, int b) {\n    return a + b;\n}\n\nint main() {\n    int total = add(4, 7);\n    cout << "Total is " << total << endl;\n    return 0;\n}'
  };

  // True when the editor still holds a starter (or nothing), meaning it is
  // safe to swap in another language's starter. Anything the user typed is
  // never replaced.
  function holdsStarter(value) {
    const trimmed = String(value || '').trim();
    if (!trimmed) return true;
    return Object.keys(STARTERS).some((key) => STARTERS[key].trim() === trimmed);
  }

  const LANGUAGE_ORDER = ['python', 'javascript', 'java', 'c', 'cpp'];

  // Every example exists in every language. The landing page used to hold one
  // hard-coded Python string per card and force `applyLanguage('python')`, so
  // "Try example" always dropped you back into Python whatever tab was active.
  const EXAMPLES = {
    // Basics
    "swap": {
      python: `left = 1
right = 2

temp = left
left = right
right = temp

print(f"left = {left}, right = {right}")`,
      javascript: `let left = 1;
let right = 2;

const temp = left;
left = right;
right = temp;

console.log("left = " + left + ", right = " + right);`,
      java: `public class Main {
    public static void main(String[] args) {
        int left = 1;
        int right = 2;

        int temp = left;
        left = right;
        right = temp;

        System.out.println("left = " + left + ", right = " + right);
    }
}`,
      c: `#include <stdio.h>

int main(void) {
    int left = 1;
    int right = 2;

    int temp = left;
    left = right;
    right = temp;

    printf("left = %d, right = %d\\n", left, right);
    return 0;
}`,
      cpp: `#include <iostream>
using namespace std;

int main() {
    int left = 1;
    int right = 2;

    int temp = left;
    left = right;
    right = temp;

    cout << "left = " << left << ", right = " << right << endl;
    return 0;
}`
    },
    "average": {
      python: `numbers = [4, 6, 5, 7]
total = 0

for number in numbers:
    total = total + number

average = total / len(numbers)
print("average", average)`,
      javascript: `const numbers = [4, 6, 5, 7];
let total = 0;

for (const number of numbers) {
  total = total + number;
}

const average = total / numbers.length;
console.log("average " + average);`,
      java: `public class Main {
    public static void main(String[] args) {
        int[] numbers = {4, 6, 5, 7};
        int total = 0;

        for (int number : numbers) {
            total = total + number;
        }

        double average = total / 4.0;
        System.out.println("average " + average);
    }
}`,
      c: `#include <stdio.h>

int main(void) {
    int numbers[] = {4, 6, 5, 7};
    int total = 0;

    for (int i = 0; i < 4; i++) {
        total = total + numbers[i];
    }

    double average = total / 4.0;
    printf("average %.1f\\n", average);
    return 0;
}`,
      cpp: `#include <iostream>
#include <vector>
using namespace std;

int main() {
    vector<int> numbers = {4, 6, 5, 7};
    int total = 0;

    for (int number : numbers) {
        total = total + number;
    }

    double average = total / 4.0;
    cout << "average " << average << endl;
    return 0;
}`
    },

    // Conditionals
    "branching": {
      python: `score = 82

if score >= 90:
    label = "excellent"
elif score >= 70:
    label = "good"
else:
    label = "keep going"

print(label)`,
      javascript: `let score = 82;
let label;

if (score >= 90) {
  label = "excellent";
} else if (score >= 70) {
  label = "good";
} else {
  label = "keep going";
}

console.log(label);`,
      java: `public class Main {
    public static void main(String[] args) {
        int score = 82;
        String label;

        if (score >= 90) {
            label = "excellent";
        } else if (score >= 70) {
            label = "good";
        } else {
            label = "keep going";
        }

        System.out.println(label);
    }
}`,
      c: `#include <stdio.h>

int main(void) {
    int score = 82;
    const char *label;

    if (score >= 90) {
        label = "excellent";
    } else if (score >= 70) {
        label = "good";
    } else {
        label = "keep going";
    }

    printf("%s\\n", label);
    return 0;
}`,
      cpp: `#include <iostream>
#include <string>
using namespace std;

int main() {
    int score = 82;
    string label;

    if (score >= 90) {
        label = "excellent";
    } else if (score >= 70) {
        label = "good";
    } else {
        label = "keep going";
    }

    cout << label << endl;
    return 0;
}`
    },
    "grade": {
      python: `score = 82

if score >= 90:
    grade = "A"
elif score >= 75:
    grade = "B"
else:
    grade = "C"

print("grade", grade)`,
      javascript: `const score = 82;
let grade;

if (score >= 90) {
  grade = "A";
} else if (score >= 75) {
  grade = "B";
} else {
  grade = "C";
}

console.log("grade " + grade);`,
      java: `public class Main {
    public static void main(String[] args) {
        int score = 82;
        String grade;

        if (score >= 90) {
            grade = "A";
        } else if (score >= 75) {
            grade = "B";
        } else {
            grade = "C";
        }

        System.out.println("grade " + grade);
    }
}`,
      c: `#include <stdio.h>

int main(void) {
    int score = 82;
    const char *grade;

    if (score >= 90) {
        grade = "A";
    } else if (score >= 75) {
        grade = "B";
    } else {
        grade = "C";
    }

    printf("grade %s\\n", grade);
    return 0;
}`,
      cpp: `#include <iostream>
#include <string>
using namespace std;

int main() {
    int score = 82;
    string grade;

    if (score >= 90) {
        grade = "A";
    } else if (score >= 75) {
        grade = "B";
    } else {
        grade = "C";
    }

    cout << "grade " << grade << endl;
    return 0;
}`
    },

    // Loops
    "loops": {
      python: `total = 0
for number in [1, 2, 3, 4]:
    total = total + number
print(total)`,
      javascript: `let total = 0;
for (const number of [1, 2, 3, 4]) {
  total = total + number;
}
console.log(total);`,
      java: `public class Main {
    public static void main(String[] args) {
        int total = 0;
        int[] numbers = {1, 2, 3, 4};
        for (int number : numbers) {
            total = total + number;
        }
        System.out.println(total);
    }
}`,
      c: `#include <stdio.h>

int main(void) {
    int total = 0;
    int numbers[4] = {1, 2, 3, 4};
    for (int i = 0; i < 4; i++) {
        total = total + numbers[i];
    }
    printf("%d\\n", total);
    return 0;
}`,
      cpp: `#include <iostream>
#include <vector>
using namespace std;

int main() {
    int total = 0;
    vector<int> numbers = {1, 2, 3, 4};
    for (int number : numbers) {
        total = total + number;
    }
    cout << total << endl;
    return 0;
}`
    },
    "whileloop": {
      python: `count = 3

while count > 0:
    print(count)
    count = count - 1

print("liftoff")`,
      javascript: `let count = 3;

while (count > 0) {
  console.log(count);
  count = count - 1;
}

console.log("liftoff");`,
      java: `public class Main {
    public static void main(String[] args) {
        int count = 3;

        while (count > 0) {
            System.out.println(count);
            count = count - 1;
        }

        System.out.println("liftoff");
    }
}`,
      c: `#include <stdio.h>

int main(void) {
    int count = 3;

    while (count > 0) {
        printf("%d\\n", count);
        count = count - 1;
    }

    printf("liftoff\\n");
    return 0;
}`,
      cpp: `#include <iostream>
using namespace std;

int main() {
    int count = 3;

    while (count > 0) {
        cout << count << endl;
        count = count - 1;
    }

    cout << "liftoff" << endl;
    return 0;
}`
    },

    // Nested loops
    "nested": {
      python: `for row in range(1, 4):
    line = ""
    for column in range(1, 4):
        line = line + str(row * column) + " "
    print(line)`,
      javascript: `for (let row = 1; row <= 3; row++) {
  let line = "";
  for (let column = 1; column <= 3; column++) {
    line = line + (row * column) + " ";
  }
  console.log(line);
}`,
      java: `public class Main {
    public static void main(String[] args) {
        for (int row = 1; row <= 3; row++) {
            for (int column = 1; column <= 3; column++) {
                System.out.print((row * column) + " ");
            }
            System.out.println();
        }
    }
}`,
      c: `#include <stdio.h>

int main(void) {
    for (int row = 1; row <= 3; row++) {
        for (int column = 1; column <= 3; column++) {
            printf("%d ", row * column);
        }
        printf("\\n");
    }
    return 0;
}`,
      cpp: `#include <iostream>
using namespace std;

int main() {
    for (int row = 1; row <= 3; row++) {
        for (int column = 1; column <= 3; column++) {
            cout << (row * column) << " ";
        }
        cout << endl;
    }
    return 0;
}`
    },
    "triangle": {
      python: `for row in range(1, 4):
    line = ""
    for star in range(row):
        line = line + "*"
    print(line)`,
      javascript: `for (let row = 1; row <= 3; row++) {
  let line = "";
  for (let star = 1; star <= row; star++) {
    line = line + "*";
  }
  console.log(line);
}`,
      java: `public class Main {
    public static void main(String[] args) {
        for (int row = 1; row <= 3; row++) {
            for (int star = 1; star <= row; star++) {
                System.out.print("*");
            }
            System.out.println();
        }
    }
}`,
      c: `#include <stdio.h>

int main(void) {
    for (int row = 1; row <= 3; row++) {
        for (int star = 1; star <= row; star++) {
            printf("*");
        }
        printf("\\n");
    }
    return 0;
}`,
      cpp: `#include <iostream>
using namespace std;

int main() {
    for (int row = 1; row <= 3; row++) {
        for (int star = 1; star <= row; star++) {
            cout << "*";
        }
        cout << endl;
    }
    return 0;
}`
    },

    // Functions
    "functions": {
      python: `def add(a, b):
    return a + b

def double(value):
    return value * 2

result = double(add(2, 3))
print(result)`,
      javascript: `function add(a, b) {
  return a + b;
}

function double(value) {
  return value * 2;
}

const result = double(add(2, 3));
console.log(result);`,
      java: `public class Main {
    static int add(int a, int b) {
        return a + b;
    }

    static int doubleValue(int value) {
        return value * 2;
    }

    public static void main(String[] args) {
        int result = doubleValue(add(2, 3));
        System.out.println(result);
    }
}`,
      c: `#include <stdio.h>

int add(int a, int b) {
    return a + b;
}

int double_value(int value) {
    return value * 2;
}

int main(void) {
    int result = double_value(add(2, 3));
    printf("%d\\n", result);
    return 0;
}`,
      cpp: `#include <iostream>
using namespace std;

int add(int a, int b) {
    return a + b;
}

int doubleValue(int value) {
    return value * 2;
}

int main() {
    int result = doubleValue(add(2, 3));
    cout << result << endl;
    return 0;
}`
    },
    "area": {
      python: `def area(width, height):
    return width * height

print("small", area(2, 3))
print("large", area(5, 4))`,
      javascript: `function area(width, height) {
  return width * height;
}

console.log("small " + area(2, 3));
console.log("large " + area(5, 4));`,
      java: `public class Main {
    static int area(int width, int height) {
        return width * height;
    }

    public static void main(String[] args) {
        System.out.println("small " + area(2, 3));
        System.out.println("large " + area(5, 4));
    }
}`,
      c: `#include <stdio.h>

int area(int width, int height) {
    return width * height;
}

int main(void) {
    printf("small %d\\n", area(2, 3));
    printf("large %d\\n", area(5, 4));
    return 0;
}`,
      cpp: `#include <iostream>
using namespace std;

int area(int width, int height) {
    return width * height;
}

int main() {
    cout << "small " << area(2, 3) << endl;
    cout << "large " << area(5, 4) << endl;
    return 0;
}`
    },

    // Recursion
    "recursion": {
      python: `def countdown(n):
    if n <= 0:
        return "go!"
    return countdown(n - 1)

result = countdown(3)
print(result)`,
      javascript: `function countdown(n) {
  if (n <= 0) {
    return "go!";
  }
  return countdown(n - 1);
}

const result = countdown(3);
console.log(result);`,
      java: `public class Main {
    static String countdown(int n) {
        if (n <= 0) {
            return "go!";
        }
        return countdown(n - 1);
    }

    public static void main(String[] args) {
        String result = countdown(3);
        System.out.println(result);
    }
}`,
      c: `#include <stdio.h>

const char *countdown(int n) {
    if (n <= 0) {
        return "go!";
    }
    return countdown(n - 1);
}

int main(void) {
    const char *result = countdown(3);
    printf("%s\\n", result);
    return 0;
}`,
      cpp: `#include <iostream>
#include <string>
using namespace std;

string countdown(int n) {
    if (n <= 0) {
        return "go!";
    }
    return countdown(n - 1);
}

int main() {
    string result = countdown(3);
    cout << result << endl;
    return 0;
}`
    },
    "factorial": {
      python: `def factorial(n):
    if n <= 1:
        return 1
    return n * factorial(n - 1)

print(factorial(5))`,
      javascript: `function factorial(n) {
  if (n <= 1) {
    return 1;
  }
  return n * factorial(n - 1);
}

console.log(factorial(5));`,
      java: `public class Main {
    static int factorial(int n) {
        if (n <= 1) {
            return 1;
        }
        return n * factorial(n - 1);
    }

    public static void main(String[] args) {
        System.out.println(factorial(5));
    }
}`,
      c: `#include <stdio.h>

int factorial(int n) {
    if (n <= 1) {
        return 1;
    }
    return n * factorial(n - 1);
}

int main(void) {
    printf("%d\\n", factorial(5));
    return 0;
}`,
      cpp: `#include <iostream>
using namespace std;

int factorial(int n) {
    if (n <= 1) {
        return 1;
    }
    return n * factorial(n - 1);
}

int main() {
    cout << factorial(5) << endl;
    return 0;
}`
    },

    // Arrays and lists
    "max": {
      python: `numbers = [7, 3, 9, 2]
largest = numbers[0]

for number in numbers:
    if number > largest:
        largest = number

print(largest)`,
      javascript: `const numbers = [7, 3, 9, 2];
let largest = numbers[0];

for (const number of numbers) {
  if (number > largest) {
    largest = number;
  }
}

console.log(largest);`,
      java: `public class Main {
    public static void main(String[] args) {
        int[] numbers = {7, 3, 9, 2};
        int largest = numbers[0];

        for (int number : numbers) {
            if (number > largest) {
                largest = number;
            }
        }

        System.out.println(largest);
    }
}`,
      c: `#include <stdio.h>

int main(void) {
    int numbers[4] = {7, 3, 9, 2};
    int largest = numbers[0];

    for (int i = 0; i < 4; i++) {
        if (numbers[i] > largest) {
            largest = numbers[i];
        }
    }

    printf("%d\\n", largest);
    return 0;
}`,
      cpp: `#include <iostream>
#include <vector>
using namespace std;

int main() {
    vector<int> numbers = {7, 3, 9, 2};
    int largest = numbers[0];

    for (int number : numbers) {
        if (number > largest) {
            largest = number;
        }
    }

    cout << largest << endl;
    return 0;
}`
    },
    "arrays": {
      python: `numbers = [4, 8, 15, 16]
total = 0

for number in numbers:
    total = total + number

print(total)`,
      javascript: `const numbers = [4, 8, 15, 16];
let total = 0;

for (const number of numbers) {
  total = total + number;
}

console.log(total);`,
      java: `public class Main {
    public static void main(String[] args) {
        int[] numbers = {4, 8, 15, 16};
        int total = 0;

        for (int number : numbers) {
            total = total + number;
        }

        System.out.println(total);
    }
}`,
      c: `#include <stdio.h>

int main(void) {
    int numbers[] = {4, 8, 15, 16};
    int total = 0;

    for (int i = 0; i < 4; i++) {
        total = total + numbers[i];
    }

    printf("%d\\n", total);
    return 0;
}`,
      cpp: `#include <iostream>
#include <vector>
using namespace std;

int main() {
    vector<int> numbers = {4, 8, 15, 16};
    int total = 0;

    for (int number : numbers) {
        total = total + number;
    }

    cout << total << endl;
    return 0;
}`
    },

    // Strings
    "strings": {
      python: `word = "visualizer"
vowels = 0

for letter in word:
    if letter in "aeiou":
        vowels = vowels + 1

print(vowels)`,
      javascript: `const word = "visualizer";
let vowels = 0;

for (const letter of word) {
  if ("aeiou".includes(letter)) {
    vowels = vowels + 1;
  }
}

console.log(vowels);`,
      java: `public class Main {
    public static void main(String[] args) {
        String word = "visualizer";
        int vowels = 0;

        for (int i = 0; i < word.length(); i++) {
            char letter = word.charAt(i);
            if ("aeiou".indexOf(letter) >= 0) {
                vowels = vowels + 1;
            }
        }

        System.out.println(vowels);
    }
}`,
      c: `#include <stdio.h>
#include <string.h>

int main(void) {
    const char *word = "visualizer";
    int vowels = 0;

    for (int i = 0; i < (int) strlen(word); i++) {
        char letter = word[i];
        if (letter == 'a' || letter == 'e' || letter == 'i' || letter == 'o' || letter == 'u') {
            vowels = vowels + 1;
        }
    }

    printf("%d\\n", vowels);
    return 0;
}`,
      cpp: `#include <iostream>
#include <string>
using namespace std;

int main() {
    string word = "visualizer";
    int vowels = 0;

    for (char letter : word) {
        if (letter == 'a' || letter == 'e' || letter == 'i' || letter == 'o' || letter == 'u') {
            vowels = vowels + 1;
        }
    }

    cout << vowels << endl;
    return 0;
}`
    },
    "palindrome": {
      python: `word = "level"
backwards = ""

for letter in word:
    backwards = letter + backwards

if word == backwards:
    print(word, "is a palindrome")
else:
    print(word, "is not a palindrome")`,
      javascript: `const word = "level";
let backwards = "";

for (const letter of word) {
  backwards = letter + backwards;
}

if (word === backwards) {
  console.log(word + " is a palindrome");
} else {
  console.log(word + " is not a palindrome");
}`,
      java: `public class Main {
    public static void main(String[] args) {
        String word = "level";
        String backwards = "";

        for (int i = 0; i < word.length(); i++) {
            backwards = word.charAt(i) + backwards;
        }

        if (word.equals(backwards)) {
            System.out.println(word + " is a palindrome");
        } else {
            System.out.println(word + " is not a palindrome");
        }
    }
}`,
      c: `#include <stdio.h>
#include <string.h>

int main(void) {
    const char *word = "level";
    int length = (int) strlen(word);
    char backwards[32];

    for (int i = 0; i < length; i++) {
        backwards[i] = word[length - 1 - i];
    }
    backwards[length] = '\\0';

    if (strcmp(word, backwards) == 0) {
        printf("%s is a palindrome\\n", word);
    } else {
        printf("%s is not a palindrome\\n", word);
    }
    return 0;
}`,
      cpp: `#include <iostream>
#include <string>
using namespace std;

int main() {
    string word = "level";
    string backwards = "";

    for (int i = 0; i < (int) word.length(); i++) {
        backwards = word[i] + backwards;
    }

    if (word == backwards) {
        cout << word << " is a palindrome" << endl;
    } else {
        cout << word << " is not a palindrome" << endl;
    }
    return 0;
}`
    },

    // Searching
    "search": {
      python: `def find(numbers, target):
    for index, number in enumerate(numbers):
        if number == target:
            return index
    return -1

position = find([4, 8, 15, 16], 15)
print("found at", position)`,
      javascript: `function find(numbers, target) {
  for (let index = 0; index < numbers.length; index++) {
    if (numbers[index] === target) {
      return index;
    }
  }
  return -1;
}

const position = find([4, 8, 15, 16], 15);
console.log("found at", position);`,
      java: `public class Main {
    static int find(int[] numbers, int target) {
        for (int index = 0; index < numbers.length; index++) {
            if (numbers[index] == target) {
                return index;
            }
        }
        return -1;
    }

    public static void main(String[] args) {
        int[] numbers = {4, 8, 15, 16};
        int position = find(numbers, 15);
        System.out.println("found at " + position);
    }
}`,
      c: `#include <stdio.h>

int find(int numbers[], int size, int target) {
    for (int index = 0; index < size; index++) {
        if (numbers[index] == target) {
            return index;
        }
    }
    return -1;
}

int main(void) {
    int numbers[] = {4, 8, 15, 16};
    int position = find(numbers, 4, 15);
    printf("found at %d\\n", position);
    return 0;
}`,
      cpp: `#include <iostream>
#include <vector>
using namespace std;

int find(const vector<int> &numbers, int target) {
    for (int index = 0; index < (int) numbers.size(); index++) {
        if (numbers[index] == target) {
            return index;
        }
    }
    return -1;
}

int main() {
    vector<int> numbers = {4, 8, 15, 16};
    int position = find(numbers, 15);
    cout << "found at " << position << endl;
    return 0;
}`
    },
    "binary": {
      python: `def binary_search(numbers, target):
    low = 0
    high = len(numbers) - 1

    while low <= high:
        middle = (low + high) // 2
        if numbers[middle] == target:
            return middle
        if numbers[middle] < target:
            low = middle + 1
        else:
            high = middle - 1

    return -1

print("found at", binary_search([1, 3, 5, 7, 9], 7))`,
      javascript: `function binarySearch(numbers, target) {
  let low = 0;
  let high = numbers.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (numbers[middle] === target) {
      return middle;
    }
    if (numbers[middle] < target) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return -1;
}

console.log("found at " + binarySearch([1, 3, 5, 7, 9], 7));`,
      java: `public class Main {
    static int binarySearch(int[] numbers, int target) {
        int low = 0;
        int high = numbers.length - 1;

        while (low <= high) {
            int middle = (low + high) / 2;
            if (numbers[middle] == target) {
                return middle;
            }
            if (numbers[middle] < target) {
                low = middle + 1;
            } else {
                high = middle - 1;
            }
        }

        return -1;
    }

    public static void main(String[] args) {
        int[] numbers = {1, 3, 5, 7, 9};
        System.out.println("found at " + binarySearch(numbers, 7));
    }
}`,
      c: `#include <stdio.h>

int binary_search(int numbers[], int size, int target) {
    int low = 0;
    int high = size - 1;

    while (low <= high) {
        int middle = (low + high) / 2;
        if (numbers[middle] == target) {
            return middle;
        }
        if (numbers[middle] < target) {
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }

    return -1;
}

int main(void) {
    int numbers[] = {1, 3, 5, 7, 9};
    printf("found at %d\\n", binary_search(numbers, 5, 7));
    return 0;
}`,
      cpp: `#include <iostream>
#include <vector>
using namespace std;

int binarySearch(const vector<int> &numbers, int target) {
    int low = 0;
    int high = (int) numbers.size() - 1;

    while (low <= high) {
        int middle = (low + high) / 2;
        if (numbers[middle] == target) {
            return middle;
        }
        if (numbers[middle] < target) {
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }

    return -1;
}

int main() {
    vector<int> numbers = {1, 3, 5, 7, 9};
    cout << "found at " << binarySearch(numbers, 7) << endl;
    return 0;
}`
    },

    // Sorting
    "sort": {
      python: `numbers = [5, 1, 4, 2]

for i in range(len(numbers)):
    for j in range(len(numbers) - 1):
        if numbers[j] > numbers[j + 1]:
            numbers[j], numbers[j + 1] = numbers[j + 1], numbers[j]

print(numbers)`,
      javascript: `const numbers = [5, 1, 4, 2];

for (let i = 0; i < numbers.length; i++) {
  for (let j = 0; j < numbers.length - 1; j++) {
    if (numbers[j] > numbers[j + 1]) {
      const temp = numbers[j];
      numbers[j] = numbers[j + 1];
      numbers[j + 1] = temp;
    }
  }
}

console.log(numbers);`,
      java: `public class Main {
    public static void main(String[] args) {
        int[] numbers = {5, 1, 4, 2};

        for (int i = 0; i < numbers.length; i++) {
            for (int j = 0; j < numbers.length - 1; j++) {
                if (numbers[j] > numbers[j + 1]) {
                    int temp = numbers[j];
                    numbers[j] = numbers[j + 1];
                    numbers[j + 1] = temp;
                }
            }
        }

        for (int number : numbers) {
            System.out.print(number + " ");
        }
        System.out.println();
    }
}`,
      c: `#include <stdio.h>

int main(void) {
    int numbers[] = {5, 1, 4, 2};

    for (int i = 0; i < 4; i++) {
        for (int j = 0; j < 3; j++) {
            if (numbers[j] > numbers[j + 1]) {
                int temp = numbers[j];
                numbers[j] = numbers[j + 1];
                numbers[j + 1] = temp;
            }
        }
    }

    for (int i = 0; i < 4; i++) {
        printf("%d ", numbers[i]);
    }
    printf("\\n");
    return 0;
}`,
      cpp: `#include <iostream>
#include <vector>
using namespace std;

int main() {
    vector<int> numbers = {5, 1, 4, 2};

    for (int i = 0; i < (int) numbers.size(); i++) {
        for (int j = 0; j < (int) numbers.size() - 1; j++) {
            if (numbers[j] > numbers[j + 1]) {
                int temp = numbers[j];
                numbers[j] = numbers[j + 1];
                numbers[j + 1] = temp;
            }
        }
    }

    for (int number : numbers) {
        cout << number << " ";
    }
    cout << endl;
    return 0;
}`
    },
    "selection": {
      python: `numbers = [5, 1, 4, 2]

for i in range(len(numbers)):
    smallest = i
    for j in range(i + 1, len(numbers)):
        if numbers[j] < numbers[smallest]:
            smallest = j
    numbers[i], numbers[smallest] = numbers[smallest], numbers[i]

print(numbers)`,
      javascript: `const numbers = [5, 1, 4, 2];

for (let i = 0; i < numbers.length; i++) {
  let smallest = i;
  for (let j = i + 1; j < numbers.length; j++) {
    if (numbers[j] < numbers[smallest]) {
      smallest = j;
    }
  }
  const temp = numbers[i];
  numbers[i] = numbers[smallest];
  numbers[smallest] = temp;
}

console.log(numbers);`,
      java: `public class Main {
    public static void main(String[] args) {
        int[] numbers = {5, 1, 4, 2};

        for (int i = 0; i < numbers.length; i++) {
            int smallest = i;
            for (int j = i + 1; j < numbers.length; j++) {
                if (numbers[j] < numbers[smallest]) {
                    smallest = j;
                }
            }
            int temp = numbers[i];
            numbers[i] = numbers[smallest];
            numbers[smallest] = temp;
        }

        for (int number : numbers) {
            System.out.print(number + " ");
        }
        System.out.println();
    }
}`,
      c: `#include <stdio.h>

int main(void) {
    int numbers[] = {5, 1, 4, 2};

    for (int i = 0; i < 4; i++) {
        int smallest = i;
        for (int j = i + 1; j < 4; j++) {
            if (numbers[j] < numbers[smallest]) {
                smallest = j;
            }
        }
        int temp = numbers[i];
        numbers[i] = numbers[smallest];
        numbers[smallest] = temp;
    }

    for (int i = 0; i < 4; i++) {
        printf("%d ", numbers[i]);
    }
    printf("\\n");
    return 0;
}`,
      cpp: `#include <iostream>
#include <vector>
using namespace std;

int main() {
    vector<int> numbers = {5, 1, 4, 2};

    for (int i = 0; i < (int) numbers.size(); i++) {
        int smallest = i;
        for (int j = i + 1; j < (int) numbers.size(); j++) {
            if (numbers[j] < numbers[smallest]) {
                smallest = j;
            }
        }
        int temp = numbers[i];
        numbers[i] = numbers[smallest];
        numbers[smallest] = temp;
    }

    for (int number : numbers) {
        cout << number << " ";
    }
    cout << endl;
    return 0;
}`
    },

    // Maps and counting
    "maps": {
      python: `votes = ["red", "blue", "red"]
counts = {}

for vote in votes:
    counts[vote] = counts.get(vote, 0) + 1

print("red appears", counts["red"], "times")`,
      javascript: `const votes = ["red", "blue", "red"];
const counts = {};

for (const vote of votes) {
  counts[vote] = (counts[vote] || 0) + 1;
}

console.log("red appears " + counts["red"] + " times");`,
      java: `import java.util.HashMap;
import java.util.Map;

public class Main {
    public static void main(String[] args) {
        String[] votes = {"red", "blue", "red"};
        Map<String, Integer> counts = new HashMap<>();

        for (String vote : votes) {
            if (counts.containsKey(vote)) {
                counts.put(vote, counts.get(vote) + 1);
            } else {
                counts.put(vote, 1);
            }
        }

        System.out.println("red appears " + counts.get("red") + " times");
    }
}`,
      c: `#include <stdio.h>
#include <string.h>

int main(void) {
    const char *votes[] = {"red", "blue", "red"};
    const char *keys[3];
    int counts[3];
    int used = 0;

    for (int i = 0; i < 3; i++) {
        int found = -1;
        for (int j = 0; j < used; j++) {
            if (strcmp(keys[j], votes[i]) == 0) {
                found = j;
            }
        }
        if (found == -1) {
            keys[used] = votes[i];
            counts[used] = 1;
            used = used + 1;
        } else {
            counts[found] = counts[found] + 1;
        }
    }

    for (int i = 0; i < used; i++) {
        if (strcmp(keys[i], "red") == 0) {
            printf("red appears %d times\\n", counts[i]);
        }
    }
    return 0;
}`,
      cpp: `#include <iostream>
#include <map>
#include <string>
using namespace std;

int main() {
    string votes[] = {"red", "blue", "red"};
    map<string, int> counts;

    for (const string &vote : votes) {
        counts[vote] = counts[vote] + 1;
    }

    cout << "red appears " << counts["red"] << " times" << endl;
    return 0;
}`
    },
    "letters": {
      python: `word = "banana"
counts = {}

for letter in word:
    counts[letter] = counts.get(letter, 0) + 1

print("a appears", counts["a"], "times")`,
      javascript: `const word = "banana";
const counts = {};

for (const letter of word) {
  counts[letter] = (counts[letter] || 0) + 1;
}

console.log("a appears " + counts["a"] + " times");`,
      java: `import java.util.HashMap;
import java.util.Map;

public class Main {
    public static void main(String[] args) {
        String word = "banana";
        Map<Character, Integer> counts = new HashMap<>();

        for (int i = 0; i < word.length(); i++) {
            char letter = word.charAt(i);
            if (counts.containsKey(letter)) {
                counts.put(letter, counts.get(letter) + 1);
            } else {
                counts.put(letter, 1);
            }
        }

        System.out.println("a appears " + counts.get('a') + " times");
    }
}`,
      c: `#include <stdio.h>
#include <string.h>

int main(void) {
    const char *word = "banana";
    char keys[16];
    int counts[16];
    int used = 0;

    for (int i = 0; i < (int) strlen(word); i++) {
        int found = -1;
        for (int j = 0; j < used; j++) {
            if (keys[j] == word[i]) {
                found = j;
            }
        }
        if (found == -1) {
            keys[used] = word[i];
            counts[used] = 1;
            used = used + 1;
        } else {
            counts[found] = counts[found] + 1;
        }
    }

    for (int i = 0; i < used; i++) {
        if (keys[i] == 'a') {
            printf("a appears %d times\\n", counts[i]);
        }
    }
    return 0;
}`,
      cpp: `#include <iostream>
#include <map>
#include <string>
using namespace std;

int main() {
    string word = "banana";
    map<char, int> counts;

    for (char letter : word) {
        counts[letter] = counts[letter] + 1;
    }

    cout << "a appears " << counts['a'] << " times" << endl;
    return 0;
}`
    },

    // Classes and objects
    "classes": {
      python: `class Dog:
    def __init__(self, name):
        self.name = name

    def speak(self):
        return self.name + " says woof"

rex = Dog("Rex")
print(rex.speak())`,
      javascript: `class Dog {
  constructor(name) {
    this.name = name;
  }

  speak() {
    return this.name + " says woof";
  }
}

const rex = new Dog("Rex");
console.log(rex.speak());`,
      java: `public class Main {
    static class Dog {
        String name;

        Dog(String name) {
            this.name = name;
        }

        String speak() {
            return name + " says woof";
        }
    }

    public static void main(String[] args) {
        Dog rex = new Dog("Rex");
        System.out.println(rex.speak());
    }
}`,
      c: `#include <stdio.h>
#include <string.h>

struct Dog {
    char name[32];
};

void speak(struct Dog dog, char *out) {
    sprintf(out, "%s says woof", dog.name);
}

int main(void) {
    struct Dog rex;
    strcpy(rex.name, "Rex");

    char message[64];
    speak(rex, message);
    printf("%s\\n", message);
    return 0;
}`,
      cpp: `#include <iostream>
#include <string>
using namespace std;

class Dog {
public:
    string name;

    Dog(string name) {
        this->name = name;
    }

    string speak() {
        return name + " says woof";
    }
};

int main() {
    Dog rex("Rex");
    cout << rex.speak() << endl;
    return 0;
}`
    },
    "counter": {
      python: `class Counter:
    def __init__(self):
        self.value = 0

    def click(self):
        self.value = self.value + 1
        return self.value

counter = Counter()
counter.click()
print(counter.click())`,
      javascript: `class Counter {
  constructor() {
    this.value = 0;
  }

  click() {
    this.value = this.value + 1;
    return this.value;
  }
}

const counter = new Counter();
counter.click();
console.log(counter.click());`,
      java: `public class Main {
    static class Counter {
        int value = 0;

        int click() {
            value = value + 1;
            return value;
        }
    }

    public static void main(String[] args) {
        Counter counter = new Counter();
        counter.click();
        System.out.println(counter.click());
    }
}`,
      c: `#include <stdio.h>

struct Counter {
    int value;
};

int click(struct Counter *counter) {
    counter->value = counter->value + 1;
    return counter->value;
}

int main(void) {
    struct Counter counter;
    counter.value = 0;

    click(&counter);
    printf("%d\\n", click(&counter));
    return 0;
}`,
      cpp: `#include <iostream>
using namespace std;

class Counter {
public:
    int value = 0;

    int click() {
        value = value + 1;
        return value;
    }
};

int main() {
    Counter counter;
    counter.click();
    cout << counter.click() << endl;
    return 0;
}`
    },

    // Errors and guards
    "errors": {
      python: `def divide(a, b):
    try:
        return a / b
    except ZeroDivisionError:
        return "cannot divide by zero"

print(divide(10, 0))`,
      javascript: `function divide(a, b) {
  try {
    if (b === 0) {
      throw new Error("cannot divide by zero");
    }
    return a / b;
  } catch (error) {
    return error.message;
  }
}

console.log(divide(10, 0));`,
      java: `public class Main {
    static String divide(int a, int b) {
        try {
            return String.valueOf(a / b);
        } catch (ArithmeticException error) {
            return "cannot divide by zero";
        }
    }

    public static void main(String[] args) {
        System.out.println(divide(10, 0));
    }
}`,
      c: `#include <stdio.h>

int main(void) {
    int a = 10;
    int b = 0;

    if (b == 0) {
        printf("cannot divide by zero\\n");
    } else {
        printf("%d\\n", a / b);
    }
    return 0;
}`,
      cpp: `#include <iostream>
#include <stdexcept>
using namespace std;

int divide(int a, int b) {
    if (b == 0) {
        throw runtime_error("cannot divide by zero");
    }
    return a / b;
}

int main() {
    try {
        cout << divide(10, 0) << endl;
    } catch (const runtime_error &error) {
        cout << error.what() << endl;
    }
    return 0;
}`
    },
    "guard": {
      python: `numbers = [4, 8, 15]
index = 5

try:
    print(numbers[index])
except IndexError:
    print("index out of range")`,
      javascript: `const numbers = [4, 8, 15];
const index = 5;

try {
  if (index >= numbers.length) {
    throw new Error("index out of range");
  }
  console.log(numbers[index]);
} catch (error) {
  console.log(error.message);
}`,
      java: `public class Main {
    public static void main(String[] args) {
        int[] numbers = {4, 8, 15};
        int index = 5;

        try {
            System.out.println(numbers[index]);
        } catch (ArrayIndexOutOfBoundsException error) {
            System.out.println("index out of range");
        }
    }
}`,
      c: `#include <stdio.h>

int main(void) {
    int numbers[] = {4, 8, 15};
    int index = 5;

    if (index < 0 || index >= 3) {
        printf("index out of range\\n");
    } else {
        printf("%d\\n", numbers[index]);
    }
    return 0;
}`,
      cpp: `#include <iostream>
#include <vector>
#include <stdexcept>
using namespace std;

int main() {
    vector<int> numbers = {4, 8, 15};
    int index = 5;

    try {
        cout << numbers.at(index) << endl;
    } catch (const out_of_range &error) {
        cout << "index out of range" << endl;
    }
    return 0;
}`
    },

    // Number logic
    "primes": {
      python: `def is_prime(number):
    if number < 2:
        return False
    for divisor in range(2, number):
        if number % divisor == 0:
            return False
    return True

number = 7

if is_prime(number):
    print(number, "is prime")
else:
    print(number, "is not prime")`,
      javascript: `function isPrime(number) {
  if (number < 2) {
    return false;
  }
  for (let divisor = 2; divisor < number; divisor++) {
    if (number % divisor === 0) {
      return false;
    }
  }
  return true;
}

const number = 7;

if (isPrime(number)) {
  console.log(number + " is prime");
} else {
  console.log(number + " is not prime");
}`,
      java: `public class Main {
    static boolean isPrime(int number) {
        if (number < 2) {
            return false;
        }
        for (int divisor = 2; divisor < number; divisor++) {
            if (number % divisor == 0) {
                return false;
            }
        }
        return true;
    }

    public static void main(String[] args) {
        int number = 7;

        if (isPrime(number)) {
            System.out.println(number + " is prime");
        } else {
            System.out.println(number + " is not prime");
        }
    }
}`,
      c: `#include <stdio.h>

int is_prime(int number) {
    if (number < 2) {
        return 0;
    }
    for (int divisor = 2; divisor < number; divisor++) {
        if (number % divisor == 0) {
            return 0;
        }
    }
    return 1;
}

int main(void) {
    int number = 7;

    if (is_prime(number)) {
        printf("%d is prime\\n", number);
    } else {
        printf("%d is not prime\\n", number);
    }
    return 0;
}`,
      cpp: `#include <iostream>
using namespace std;

bool isPrime(int number) {
    if (number < 2) {
        return false;
    }
    for (int divisor = 2; divisor < number; divisor++) {
        if (number % divisor == 0) {
            return false;
        }
    }
    return true;
}

int main() {
    int number = 7;

    if (isPrime(number)) {
        cout << number << " is prime" << endl;
    } else {
        cout << number << " is not prime" << endl;
    }
    return 0;
}`
    },
    "digits": {
      python: `number = 472
total = 0

while number > 0:
    total = total + number % 10
    number = number // 10

print(total)`,
      javascript: `let number = 472;
let total = 0;

while (number > 0) {
  total = total + (number % 10);
  number = Math.floor(number / 10);
}

console.log(total);`,
      java: `public class Main {
    public static void main(String[] args) {
        int number = 472;
        int total = 0;

        while (number > 0) {
            total = total + (number % 10);
            number = number / 10;
        }

        System.out.println(total);
    }
}`,
      c: `#include <stdio.h>

int main(void) {
    int number = 472;
    int total = 0;

    while (number > 0) {
        total = total + (number % 10);
        number = number / 10;
    }

    printf("%d\\n", total);
    return 0;
}`,
      cpp: `#include <iostream>
using namespace std;

int main() {
    int number = 472;
    int total = 0;

    while (number > 0) {
        total = total + (number % 10);
        number = number / 10;
    }

    cout << total << endl;
    return 0;
}`
    },
  };

  const EXAMPLE_TITLES = { "swap": "Swapping", "average": "Average", "branching": "Branching", "grade": "Grade bands", "loops": "Loops", "whileloop": "While loop", "nested": "Nested loops", "triangle": "Star triangle", "functions": "Functions", "area": "Reuse a function", "recursion": "Recursion", "factorial": "Factorial", "max": "Largest value", "arrays": "Arrays", "strings": "Strings", "palindrome": "Palindrome", "search": "Searching", "binary": "Binary search", "sort": "Sorting", "selection": "Selection sort", "maps": "Maps", "letters": "Letter count", "classes": "Classes", "counter": "Counter object", "errors": "Errors", "guard": "Index guard", "primes": "Number logic", "digits": "Digit sum" };

  function exampleSource(name, language) {
    const group = EXAMPLES[name];
    if (!group) return '';
    return group[language] || group.python || '';
  }

  // An example already on screen is as disposable as a starter: switching
  // language should swap it for the same example in the new language rather
  // than leave Python source under a "C++" tab.
  function matchesAnyExample(value) {
    const trimmed = String(value || '').trim();
    if (!trimmed) return false;
    return Object.keys(EXAMPLES).some((name) => LANGUAGE_ORDER.some(
      (language) => String(EXAMPLES[name][language] || '').trim() === trimmed
    ));
  }

  function holdsReplaceable(value) {
    return holdsStarter(value) || matchesAnyExample(value);
  }

  function fileNameFor(language) {
    return FILE_NAMES[language] || 'main.txt';
  }

  function applyLanguage(language) {
    state.language = language;
    state.exampleLanguage = language;
    const tabs = $('language-tabs');
    if (tabs) {
      tabs.querySelectorAll('.lang-tab').forEach((tab) => {
        tab.setAttribute('aria-pressed', String(tab.dataset.language === language));
      });
    }
    setText('file-name', fileNameFor(language));
    document.body.dataset.language = language;
    const editor = $('code-editor');
    if (editor && holdsReplaceable(editor.value)) {
      // Keep the reader where they were: an example stays an example, a
      // starter becomes the starter of the new language.
      const swap = (state.example && exampleSource(state.example, language)) || STARTERS[language] || '';
      if (swap && editor.value !== swap) {
        editor.value = swap;
        state.source = swap;
        updateLineNumbers();
      }
    }
    refreshHighlight();
    syncExampleLanguage();
    try { localStorage.setItem('codeflow.language', language); } catch (_) { /* persistence is optional */ }
    if (!state.trace.length) renderDiagnosticPlaceholder();
  }

  // The examples section carries its own language pills. They are the same
  // five languages as the editor tabs and they stay in step with them, so
  // "Try example" can never hand Python source to a C++ tab.
  function syncExampleLanguage() {
    const group = $('example-langs');
    if (group) {
      group.querySelectorAll('.example-lang').forEach((button) => {
        button.setAttribute('aria-pressed', String(button.dataset.language === state.exampleLanguage));
      });
    }
    renderExamplePreviews();
  }

  function renderExamplePreviews() {
    all('[data-example-preview]').forEach((node) => {
      const name = node.dataset.examplePreview;
      const source = exampleSource(name, state.exampleLanguage);
      if (!source) { node.textContent = ''; return; }
      const lines = source.split('\n');
      const preview = lines.slice(0, 5);
      if (lines.length > 5) preview.push('…');
      node.textContent = preview.join('\n');
      node.dataset.lang = LANGUAGE_LABELS[state.exampleLanguage] || state.exampleLanguage;
    });
  }

  function renderDiagnosticPlaceholder() {
    const diagnostics = $('diagnostics-output');
    if (!diagnostics) return;
    diagnostics.innerHTML = `<div class="diagnostic-line"><span class="check">✓</span><div><b>Code looks good</b><small>Ready to execute your ${LANGUAGE_LABELS[state.language] || 'program'} program.</small></div></div>`;
  }

  // A trace belongs to the program that produced it. Switching language (or
  // loading a different starter) leaves the old steps on screen otherwise,
  // so C++ steps sit next to Python source.
  function resetTrace() {
    state.trace = [];
    state.step = 0;
    state.lastResult = null;
    state.executedSource = '';
    state.activeLine = null;
    const flow = $('flow-map');
    if (flow) flow.innerHTML = '<div class="flow-empty">Run the program to build a trace from returned events.</div>';
    const consoleOutput = $('console-output');
    if (consoleOutput) consoleOutput.innerHTML = '<div class="console-line muted-line"><span>›</span> <span>Run the program to see output here</span></div>';
    renderDiagnosticPlaceholder();
    setText('step-count', '0 / 0');
    setText('run-status', 'Waiting for your code');
    updateTimeline();
    renderSelectedEvent();
    updateLineNumbers();
  }

  function encodeShare(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
    return window.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function decodeShare(value) {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = window.atob(padded + '==='.slice((padded.length + 3) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new TextDecoder().decode(bytes);
  }

  function shareCode() {
    const editor = $('code-editor');
    if (!editor) return;
    const source = editor.value;
    if (source.length > 4000) {
      showToast('This program is too long to share as a link. Use Export instead.');
      return;
    }
    const url = `${window.location.origin}${window.location.pathname}#lang=${encodeURIComponent(state.language)}&code=${encodeShare(source)}`;
    const done = () => showToast('Share link copied to the clipboard.');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done).catch(() => {
        window.history.replaceState(null, '', url);
        showToast('Share link added to the address bar.');
      });
    } else {
      window.history.replaceState(null, '', url);
      showToast('Share link added to the address bar.');
    }
  }

  function applyShareLink() {
    const hash = window.location.hash.replace(/^#/, '');
    if (!hash) return false;
    const params = new URLSearchParams(hash);
    const encoded = params.get('code');
    if (!encoded) return false;
    try {
      const source = decodeShare(encoded);
      const language = _normalize(params.get('lang'));
      const editor = $('code-editor');
      if (editor && source) {
        editor.value = source;
        state.source = source;
        state.snapshot = source;
        state.history = [source];
      }
      if (language) applyLanguage(language);
      updateLineNumbers();
      return true;
    } catch (_) {
      return false;
    }
  }

  function _normalize(language) {
    if (!language) return null;
    const key = String(language).toLowerCase();
    const alias = { js: 'javascript', 'c++': 'cpp', cxx: 'cpp' }[key] || key;
    return FILE_NAMES[alias] ? alias : null;
  }

  let lastHighlightKey = null;

  function escapeForEditor(value) {
    return String(value).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }

  function syncHighlightScroll() {
    const editor = $('code-editor');
    const highlight = $('editor-highlight');
    const numbers = $('line-numbers');
    if (!editor) return;
    if (highlight) {
      highlight.scrollTop = editor.scrollTop;
      highlight.scrollLeft = editor.scrollLeft;
    }
    // The gutter is its own column, so it has to be moved by hand or the
    // numbers stay behind once a file is longer than the panel.
    if (numbers) numbers.scrollTop = editor.scrollTop;
  }

  // The visible text lives in a <pre> behind a transparent textarea, so the
  // two must be redrawn together or the caret drifts away from the words.
  function refreshHighlight() {
    const editor = $('code-editor');
    const target = $('editor-highlight-code');
    if (!editor || !target) return;
    const key = state.language + '\u0000' + editor.value;
    if (key === lastHighlightKey) return;
    lastHighlightKey = key;
    const tokenizer = window.CodeFlowLesson && window.CodeFlowLesson.highlight;
    const source = editor.value;
    // <pre> ignores a trailing newline; the sentinel keeps the final empty
    // line tall enough for the caret to sit on it.
    target.innerHTML = (tokenizer ? tokenizer(source, state.language) : escapeForEditor(source)) + '\n ';
    syncHighlightScroll();
  }

  function updateLineNumbers() {
    const editor = $('code-editor');
    const numbers = $('line-numbers');
    if (!editor || !numbers) return;
    refreshHighlight();
    const count = Math.max(1, editor.value.split('\n').length);
    numbers.innerHTML = Array.from({ length: count }, (_, index) => `<span class="${index + 1 === state.activeLine ? 'active' : ''}">${String(index + 1).padStart(2, '0')}</span>`).join('\n');
  }

  function updateCursor() {
    const editor = $('code-editor');
    if (!editor) return;
    const before = editor.value.slice(0, editor.selectionStart);
    const lines = before.split('\n');
    setText('cursor-position', `Ln ${lines.length}, Col ${lines[lines.length - 1].length + 1}`);
  }

  function saveSnapshot() {
    const editor = $('code-editor');
    if (!editor) return;
    state.source = editor.value;
    try { localStorage.setItem('codeflow.source', state.source); } catch (_) { /* persistence is optional */ }
    setText('save-state', 'Unsaved changes');
    window.clearTimeout(saveSnapshot.timeout);
    // A restore point is committed only once typing pauses, so undo steps
    // back through edits rather than through individual keystrokes.
    saveSnapshot.timeout = window.setTimeout(() => {
      commitSnapshot();
      setText('save-state', 'All changes saved');
    }, 650);
  }

  function commitSnapshot() {
    window.clearTimeout(saveSnapshot.timeout);
    if (state.history[state.history.length - 1] !== state.source) {
      state.history.push(state.source);
      if (state.history.length > 40) state.history.shift();
    }
    state.snapshot = state.source;
  }

  function renderVariables(variables) {
    const list = $('variables-list');
    if (!list) return;
    const entries = Object.entries(variables || {});
    setText('variable-count', String(entries.length));
    list.innerHTML = entries.length ? entries.map(([name, value]) => {
      const type = Array.isArray(value) ? 'list' : value === null ? 'none' : typeof value;
      const display = typeof value === 'string' ? `"${value}"` : (JSON.stringify(value) ?? cleanText(String(value)));
      return `<div class="data-row"><span class="data-type">${type}</span><b>${escapeHtml(name)}</b><code>${escapeHtml(display)}</code></div>`;
    }).join('') : '<div class="data-row"><span class="data-type">—</span><b>No variables</b><code>run code first</code></div>';
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
  }

  function renderConsole(lines, fallback = false) {
    // Full reset of the stream (Clear button, offline fallback, hard errors).
    const safeLines = Array.isArray(lines) ? lines : [String(lines || '')];
    state.termEntries = safeLines.filter((line) => line !== '').map((line) => ({ kind: 'out', text: String(line) }));
    state.termShown = state.termEntries.map((entry) => entry.text);
    state.lastOutput = state.termShown;
    renderTerminal();
    if (fallback) showToast('API unavailable — ran the offline Python subset.');
  }

  function pushTerm(kind, text) {
    state.termEntries.push({ kind, text: String(text) });
  }

  // One scrolling stream, like a VS Code terminal: echoed input, program
  // output and errors in the order they actually happened.
  function renderTerminal() {
    const out = $('console-output');
    if (!out) return;
    const entries = state.termEntries || [];
    if (!entries.length) {
      out.innerHTML = '<div class="console-line muted-line"><span>›</span><span>Run the program to see output here</span></div>';
    } else {
      out.innerHTML = entries.map((entry) => {
        const cls = entry.kind === 'input' ? 'console-line terminal-echo'
          : entry.kind === 'err' ? 'console-line terminal-err'
            : entry.kind === 'note' ? 'console-line muted-line'
              : 'console-line';
        return `<div class="${cls}"><span>›</span><span>${escapeHtml(entry.text)}</span></div>`;
      }).join('');
    }
    out.scrollTop = out.scrollHeight;
  }

  // The prompt row has three real states: idle, running, and blocked on input().
  function updatePromptState() {
    const row = document.querySelector('.terminal-prompt-row');
    const input = $('terminal-input');
    if (!row || !input) return;
    row.classList.toggle('waiting', Boolean(state.awaitingInput));
    row.classList.toggle('running', Boolean(state.termRunning));
    input.disabled = Boolean(state.termRunning);
    if (state.termRunning) input.placeholder = 'Running…';
    else if (state.awaitingInput) input.placeholder = 'Type a value ↵';
    else input.placeholder = 'Type input ↵';
  }

  // The backend reports a program blocked on input() as an EOFError. That is
  // not a real error — it is the signal to show the prompt and keep going.
  function isEofDiagnostic(item) {
    if (!item) return false;
    return /^EOFError$/i.test(String(item.title || '')) || /EOF when reading a line/i.test(String(item.message || item.detail || ''));
  }

  // Python signals a blocked input() with EOFError. Compiled languages read
  // stdin from a file, so they never block — the backend reports status
  // "waiting" plus an explicit flag instead.
  function isWaitingForInput(result) {
    if (!result) return false;
    if (result.waiting_for_input) return true;
    const diagnostics = result.diagnostics || result.errors || [];
    return diagnostics.some(isEofDiagnostic);
  }

  function executeOutputLines(result) {
    if (!result) return [];
    const lines = Array.isArray(result.output)
      ? result.output.slice()
      : result.stdout ? String(result.stdout).split('\n') : [];
    return lines.map((line) => String(line)).filter((line) => line !== '');
  }

  // The "Program input" dialog. It was wired to nothing but its own close
  // button — you could type three values and press Done and the program still
  // received none of them. It now seeds from whatever has already been typed
  // and writes the lines back into `stdinLines` when Done is pressed.
  function openInputDialog() {
    const modal = $('stdin-modal');
    const field = $('stdin-input');
    if (!modal || !field) return false;
    field.value = (state.stdinLines || []).join('\n');
    modal.classList.remove('hidden');
    window.setTimeout(() => field.focus(), 30);
    return true;
  }

  function applyInputDialog() {
    const field = $('stdin-input');
    if (!field) return;
    const lines = field.value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    // A trailing newline is not an empty input — drop only trailing blanks.
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    state.stdinLines = lines;
    $('stdin-modal').classList.add('hidden');
    // resetInput:false keeps the lines we just read.
    runCode({ resetInput: false });
  }

  // Enter in the prompt: if the program is blocked on input(), feed the line to
  // it and resume automatically — no second Run click needed.
  function submitTerminalLine() {
    const input = $('terminal-input');
    if (!input || state.termRunning) return;
    const value = input.value;
    if (value === '' && !state.awaitingInput) return;
    input.value = '';
    if (state.awaitingInput) {
      state.stdinLines.push(value);
      pushTerm('input', value);
    } else {
      // Nothing is waiting: this line starts a new run as its first input.
      state.stdinLines = [value];
      state.termEntries = [];
      state.termShown = [];
      pushTerm('input', value);
    }
    state.awaitingInput = false;
    renderTerminal();
    updatePromptState();
    runCode({ fresh: false });
  }

  function renderLimits(result) {
    const note = $('limit-note');
    if (!note) return;
    const limits = (result && result.limits) || {};
    const messages = [];
    if (limits.events_truncated) messages.push('The trace hit the event limit, so later steps are missing.');
    if (limits.stdout_truncated) messages.push('Console output was truncated.');
    if (limits.stderr_truncated) messages.push('Error output was truncated.');
    if (!messages.length) {
      note.classList.add('hidden');
      note.textContent = '';
      return;
    }
    note.classList.remove('hidden');
    note.textContent = messages.join(' ');
  }

  function renderDiagnostics(diagnostics, ok = true) {
    const list = $('diagnostics-output');
    const status = $('diagnostic-status');
    if (!list || !status) return;
    const items = Array.isArray(diagnostics) ? diagnostics.filter(Boolean) : diagnostics ? [diagnostics] : [];
    state.diagnostics = items;
    status.className = ok ? 'diagnostic-ok' : 'diagnostic-ok issue';
    status.textContent = ok ? '● No issues' : `● ${items.length} issue${items.length === 1 ? '' : 's'}`;
    list.innerHTML = items.length ? items.map((item) => {
      const line = Number.isInteger(item && item.line) ? ` data-line="${item.line}"` : '';
      const info = item && item.kind === 'unsupported';
      const glyph = info ? 'ℹ' : (ok ? '✓' : '!');
      const infoClass = info ? ' diagnostic-info' : '';
      return `<div class="diagnostic-line${infoClass}"${line} tabindex="${line ? '0' : '-1'}"><span class="check">${glyph}</span><div><b>${escapeHtml(item.title || item.message || item)}</b><small>${escapeHtml(item.detail || 'Review this line and try again.')}${item.line ? ` · line ${item.line}${item.column ? `:${item.column}` : ''}` : ''}</small></div></div>`;
    }).join('') : '<div class="diagnostic-line"><span class="check">✓</span><div><b>Code looks good</b><small>Ready to execute your program.</small></div></div>';
    const firstLine = items[0] && Number(items[0].line);
    if (Number.isInteger(firstLine) && firstLine > 0) focusSourceLine(firstLine);
  }

  function setApiStatus(online) {
    state.apiOnline = online;
    const badge = $('api-badge');
    const note = $('offline-note');
    if (!badge || !note) return;
    badge.textContent = online ? 'API ready' : 'Offline mode';
    badge.classList.toggle('offline', !online);
    note.innerHTML = online ? '<span>●</span> API connected · offline fallback remains available' : '<span>◌</span> Offline fallback available for this Python subset';
  }

  function setAiProviderStatus(kind, detail) {
    const badge = $('ai-provider-status');
    const labels = { remote: 'Remote AI', local: 'Local fallback', notConfigured: 'Not configured', error: 'Remote AI · error' };
    if (badge) {
      badge.textContent = labels[kind] || labels.notConfigured;
      badge.className = `ai-provider-badge ${kind}`;
    }
    if (detail) setText('ai-status', detail);
  }

  function aiContext(prompt) {
    return {
      mode: 'chat',
      prompt,
      language: state.language,
      code: $('code-editor').value,
      diagnostics: state.diagnostics,
      selected_event: state.trace.length ? (state.trace[state.step] || null) : null
    };
  }

  function renderAiProposal(proposed) {
    const container = $('ai-proposal');
    if (!container) return;
    if (!proposed || typeof proposed.code !== 'string') {
      container.classList.add('hidden');
      container.innerHTML = '';
      return;
    }
    const language = proposed.language || state.language;
    container.classList.remove('hidden');
    container.innerHTML = `<div class="proposal-heading"><b>Proposed ${escapeHtml(language)} code</b><button class="button button-ghost small-button" type="button">Apply</button></div><pre>${escapeHtml(proposed.code)}</pre>${proposed.explanation ? `<small>${escapeHtml(proposed.explanation)}</small>` : ''}`;
    const apply = container.querySelector('button');
    if (apply) apply.addEventListener('click', () => {
      const editor = $('code-editor');
      editor.value = proposed.code;
      if (FILE_NAMES[language]) applyLanguage(language);
      updateLineNumbers();
      updateCursor();
      saveSnapshot();
      showToast('Proposed code applied to the editor.');
    });
  }

  function localAiFallback(prompt) {
    const event = state.trace[state.step];
    if (event) {
      const label = eventLabel(event, state.step);
      return `Local fallback (no LLM): the selected ${label.type} event is ${label.line.toLowerCase()}. Inspect the highlighted source line and its recorded variables for evidence about “${prompt}”.`;
    }
    const diagnostics = state.diagnostics;
    if (diagnostics.length) return `Local fallback (no LLM): the execution service reported ${diagnostics.length} diagnostic${diagnostics.length === 1 ? '' : 's'}. Review the Diagnostics panel for the recorded issue before changing the code.`;
    return 'Local fallback (no LLM): run the code and select a trace event to get an evidence-based explanation. No runtime claim was generated.';
  }

  async function refreshHealth() {
    try {
      const response = await fetch('/api/health');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const health = await response.json();
      setApiStatus(true);
      state.aiConfigured = Boolean(health.ai_configured);
      if (health.ai_configured) setAiProviderStatus('remote', 'Remote AI · provider credentials detected');
      else setAiProviderStatus('notConfigured', 'Not configured · set CODEFLOW_AI_API_KEY on the backend');
    } catch (_) {
      setApiStatus(false);
      setAiProviderStatus('local', 'Local fallback · backend unavailable');
    }
  }

  function focusSourceLine(line) {
    const editor = $('code-editor');
    const lineNumber = Number(line);
    if (!editor || !Number.isInteger(lineNumber) || lineNumber < 1) return;
    state.activeLine = lineNumber;
    updateLineNumbers();
    const lines = editor.value.split('\n');
    const start = lines.slice(0, lineNumber - 1).reduce((total, value) => total + value.length + 1, 0);
    editor.focus();
    editor.setSelectionRange(start, start + (lines[lineNumber - 1] || '').length);
    editor.scrollTop = Math.max(0, (lineNumber - 1) * parseFloat(window.getComputedStyle(editor).lineHeight || '20') - editor.clientHeight / 3);
    setText('cursor-position', `Ln ${lineNumber}, Col 1`);
  }

  function eventLabel(event, index) {
    const lineNumber = Number(event && event.line);
    const line = Number.isInteger(lineNumber) && lineNumber > 0 ? `Line ${lineNumber}` : `Step ${index + 1}`;
    const type = eventType(event);
    return { line, type };
  }

  function eventType(event) {
    return String(event && (event.type || event.event || 'unknown')).replace(/[-_]/g, ' ').trim() || 'unknown';
  }

  function eventVariables(event) {
    const values = event && (event.variables || event.locals || event.environment);
    return values && typeof values === 'object' && !Array.isArray(values) ? values : {};
  }

  function cleanText(text) {
    // Repr of objects leaks heap addresses like "<function f at 0x104e55260>".
    return String(text).replace(/ at 0x[0-9a-fA-F]+/g, '');
  }

  function valueText(value) {
    if (value === undefined) return 'Unknown';
    if (typeof value === 'string') return `"${value}"`;
    try {
      const json = JSON.stringify(value);
      return json === undefined ? cleanText(String(value)) : json;
    } catch (_) {
      return cleanText(String(value));
    }
  }

  function sourceLineForEvent(event) {
    const line = Number(event && event.line);
    const source = state.executedSource || ($('code-editor') && $('code-editor').value) || '';
    if (Number.isInteger(line) && line > 0) {
      const sourceLines = source.split('\n');
      if (line <= sourceLines.length) return sourceLines[line - 1];
    }
    if (typeof event.source_code === 'string') return event.source_code;
    if (typeof event.source === 'string') return event.source;
    if (typeof event.code === 'string') return event.code;
    return '';
  }

  function changedVariables(index) {
    const current = eventVariables(state.trace[index]);
    const previous = index > 0 ? eventVariables(state.trace[index - 1]) : {};
    const names = new Set([...Object.keys(previous), ...Object.keys(current)]);
    return Array.from(names).filter((name) => valueText(previous[name]) !== valueText(current[name])).map((name) => ({
      name,
      before: Object.prototype.hasOwnProperty.call(previous, name) ? previous[name] : undefined,
      after: Object.prototype.hasOwnProperty.call(current, name) ? current[name] : undefined,
      removed: Object.prototype.hasOwnProperty.call(previous, name) && !Object.prototype.hasOwnProperty.call(current, name)
    }));
  }

  function joinList(items) {
    if (items.length <= 1) return items.join('');
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
  }

  function describeChanges(changes, isFirst) {
    if (!changes.length) return isFirst ? ' No variables exist yet at this point.' : ' Nothing changed since the previous step.';
    const parts = changes.map((change) => {
      if (change.removed) return `${change.name} was removed`;
      if (change.before === undefined) return `${change.name} is now ${valueText(change.after)}`;
      return `${change.name} went from ${valueText(change.before)} to ${valueText(change.after)}`;
    });
    return ` After this step, ${joinList(parts)}.`;
  }

  function argsText(event) {
    const args = event && event.args;
    if (Array.isArray(args) && args.length) return ` It was called with ${joinList(args.map((a) => valueText(a)))}.`;
    return '';
  }

  function eventExplanation(event, changes, isFirst) {
    const type = eventType(event).toLowerCase();
    const functionName = event && (event.function || event.name);
    const line = Number(event && event.line);
    const location = Number.isInteger(line) && line > 0 ? ` on line ${line}` : '';
    const code = (sourceLineForEvent(event) || '').trim();
    const codeText = code ? ` This line runs: ${code}` : '';
    if (type === 'call') return `We step into ${functionName ? `the ${functionName}() function` : 'a function'}${location}.${codeText}${argsText(event)}`;
    if (type === 'return') {
      if (event && event.unwound) return `We leave ${functionName ? `the ${functionName}() function` : 'the function'}${location} because an error was bubbling up — so it hands back nothing.`;
      const returned = event && (event.return_value ?? event.returnValue ?? event.value);
      return returned === undefined
        ? `The ${functionName ? `${functionName}() ` : ''}function finishes${location} and hands back a value.${codeText}`
        : `The ${functionName ? `${functionName}() ` : ''}function finishes${location} and returns ${valueText(returned)}.${codeText}`;
    }
    if (type === 'exception' || type === 'error') return `Something went wrong${location}${event && event.exception ? `: ${event.exception}` : '.'}${codeText}`;
    if (type === 'stdout' || type === 'output') {
      const output = event && (event.output ?? event.value ?? event.text);
      const shown = output === undefined ? 'something' : (typeof output === 'string' ? output.replace(/\n+$/g, '') : valueText(output));
      return `The program prints: ${shown}${location}.${codeText}`;
    }
    if (type === 'input' || type === 'stdin') {
      const text = (event && event.input != null) ? String(event.input).replace(/\r\n/g, '\n').trim() : '';
      const shown = text ? `: ${text.replace(/\n/g, ', ')}` : '';
      return `The program pauses and reads the input you supplied${shown}. That is the value it uses wherever the code asks for input().`;
    }
    if (type === 'line') {
      return `We run this line${location}.${codeText}${describeChanges(changes, isFirst)}`;
    }
    return `This is a “${eventType(event)}” step — we don’t have a plain description for it yet.${codeText}`;
  }

  function renderTrace(result, source) {
    let events = Array.isArray(result && (result.events || result.trace)) ? (result.events || result.trace) : [];
    const stdin = (state.lastStdin || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    if (stdin && events.length) {
      const inputEvent = { type: 'input', line: null, function: null, variables: {}, call_stack: [], input: state.lastStdin, sequence: 1 };
      const arranged = events.slice();
      arranged.splice(Math.min(1, arranged.length), 0, inputEvent);
      events = arranged;
    }
    state.trace = events;
    state.lastResult = result || null;
    state.executedSource = typeof source === 'string' ? source : state.executedSource;
    const flow = $('flow-map');
    if (flow && events.length) {
      flow.innerHTML = `<div class="flow-line"></div>${events.map((event, index) => {
        const label = eventLabel(event, index);
        return `<button class="flow-step${index === 0 ? ' active' : ''}" data-step="${index}" aria-label="Trace step ${index + 1}, ${escapeHtml(label.type)}"><b>${String(index + 1).padStart(2, '0')}</b><span>${escapeHtml(label.line)}</span><small>${escapeHtml(label.type)}</small></button>`;
      }).join('')}`;
    } else if (flow) {
      flow.innerHTML = '<div class="flow-empty">No execution events returned. Behavior is unknown for this run.</div>';
    }
    state.step = events.length ? 0 : 0;
    updateTimeline();
  }

  function renderSelectedEvent() {
    const event = state.trace[state.step];
    if (!event) {
      state.activeLine = null;
      updateLineNumbers();
      setText('event-title', 'No event selected');
      setText('event-type', 'Unknown');
      setText('event-meta', state.trace.length ? 'Unknown event selection.' : 'No events were returned by the execution service.');
      setText('event-source', 'Unknown source');
      setText('event-explanation', 'Unknown behavior — no execution event is selected.');
      renderVariables(state.lastResult && state.lastResult.variables ? state.lastResult.variables : {});
      renderChangedVariables([]);
      renderStack(state.lastResult && state.lastResult.call_stack);
      renderEventOutput(null);
      return;
    }
    const changes = changedVariables(state.step);
    const type = eventType(event);
    const line = Number(event.line);
    const hasLine = Number.isInteger(line) && line > 0;
    if (hasLine) focusSourceLine(line);
    else {
      state.activeLine = null;
      updateLineNumbers();
    }
    setText('event-title', hasLine ? `Step ${state.step + 1} · line ${line}` : `Step ${state.step + 1}`);
    setText('event-type', type);
    setText('event-meta', `Sequence ${event.sequence ?? state.step} · ${type}${hasLine ? ` · line ${line}` : ''}`);
    setText('event-source', sourceLineForEvent(event) || 'Unknown source line');
    const localText = eventExplanation(event, changes, state.step === 0);
    setText('event-explanation', localText);
    renderVariables(eventVariables(event));
    renderChangedVariables(changes);
    renderStack(event.call_stack || event.stack);
    renderEventOutput(event);
    if (event.line) setText('run-status', `Viewing line ${event.line} · ${type}`);
    // The "What happened" panel shows only the local step narrative. The AI is
    // fetched on demand — only when the user presses Explain (explainInPanel),
    // never automatically on step select.
    if (state.explainTimer) { clearTimeout(state.explainTimer); state.explainTimer = null; }
  }

  async function fetchStepExplanation(event, localText) {
    const token = ++state.explainToken;
    const box = $('event-explanation');
    if (box) {
      box.textContent = 'Asking the AI to explain this step…';
      box.classList.add('explaining');
    }
    const result = await callApi('/api/ai', {
      ...aiContext('Explain, in plain simple language for a beginner programmer, exactly what happens at this execution step. Refer to the source line and any variable values shown in the evidence. Keep it to 2–3 short sentences — no code fences, no headings.'),
      mode: 'explain-step',
      selected_event: event
    });
    if (token !== state.explainToken) return; // a newer step was selected meanwhile
    if (box) box.classList.remove('explaining');
    if (result && result.status === 'ok' && typeof (result.answer || result.response) === 'string') {
      setText('event-explanation', (result.answer || result.response).trim());
    } else if (box && localText) {
      // Provider unavailable / not configured / errored: keep the local text.
      box.textContent = localText;
    }
  }

  function renderChangedVariables(changes) {
    const list = $('changed-variables');
    if (!list) return;
    list.innerHTML = changes.length ? changes.map((change) => `<div class="data-row changed-row"><span class="data-type">${change.removed ? 'removed' : 'changed'}</span><b>${escapeHtml(change.name)}</b><code>${change.removed ? `${escapeHtml(valueText(change.before))} → Unknown` : `${escapeHtml(valueText(change.before))} → ${escapeHtml(valueText(change.after))}`}</code></div>`).join('') : '<div class="data-row empty-row"><span class="data-type">—</span><b>None recorded</b><code>no changes in this event</code></div>';
  }

  function renderStack(callStack) {
    const stack = $('stack-list');
    const stackState = $('stack-state');
    if (stack) {
      const frames = Array.isArray(callStack) ? callStack : [];
      if (stackState) stackState.textContent = frames.length ? `${frames.length} frame${frames.length === 1 ? '' : 's'}` : 'Unknown';
      stack.innerHTML = frames.length ? frames.slice().reverse().map((frame, index) => {
        const name = typeof frame === 'string' ? frame : frame && (frame.function || frame.name || frame.label);
        const frameLine = typeof frame === 'object' && frame ? frame.line : undefined;
        return `<div class="stack-row${index === 0 ? ' current' : ''}"><span class="stack-icon">↳</span><div><b>${escapeHtml(name || 'Unknown')}</b><small>${frameLine ? `line ${escapeHtml(frameLine)}` : 'line Unknown'}</small></div></div>`;
      }).join('') : '<div class="stack-row current"><span class="stack-icon">↳</span><div><b>Unknown</b><small>No call-stack data returned.</small></div></div>';
    }
  }

  function renderEventOutput(event) {
    const output = $('event-output');
    const status = $('event-output-status');
    const inline = output ? output.closest('.event-output-inline') : null;
    const heading = inline ? inline.querySelector('.inline-heading span') : null;
    if (!output) return;
    if (event && (event.type === 'input' || event.type === 'stdin')) {
      const text = (event.input != null ? String(event.input) : '').replace(/\r\n/g, '\n').trim();
      if (status) status.textContent = text ? 'Input' : 'Unknown';
      if (heading) heading.textContent = 'Selected input';
      output.innerHTML = text ? text.split('\n').map((line) => `<div class="console-line"><span>›</span><span>${escapeHtml(line)}</span></div>`).join('') : '<div class="console-line muted-line"><span>›</span><span>No input recorded for this event.</span></div>';
      return;
    }
    if (heading) heading.textContent = 'Selected output';
    const values = event && (event.output ?? event.outputs ?? event.stdout);
    const lines = Array.isArray(values) ? values : values === undefined || values === null ? [] : String(values).split('\n').filter(Boolean);
    if (status) status.textContent = lines.length ? 'Recorded' : 'Unknown';
    output.innerHTML = lines.length ? lines.map((line) => `<div class="console-line"><span>›</span><span>${escapeHtml(line)}</span></div>`).join('') : '<div class="console-line muted-line"><span>›</span><span>No output recorded for this event.</span></div>';
  }

  function parseLiteral(value, variables) {
    const trimmed = value.trim();
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
    if (trimmed === 'True') return true;
    if (trimmed === 'False') return false;
    if (trimmed === 'None') return null;
    if (variables[trimmed] !== undefined) return variables[trimmed];
    return trimmed;
  }

  function offlinePython(source) {
    const variables = {};
    const output = [];
    const diagnostics = [];
    const events = [];
    const lines = source.split('\n');
    const unsupported = lines.find((rawLine) => /^(for|while|if|elif|else|try|with|class|async|await|match|case)\b/.test(rawLine.trim()));
    if (unsupported) {
      return {
        output: [], variables: {}, events: [], lines: lines.length, status: 'unsupported',
        diagnostics: [{ title: 'Offline subset boundary', detail: 'This construct needs the CodeFlow execution service. No runtime values were invented.' }]
      };
    }
    const functions = {};
    lines.forEach((line, index) => {
      const functionMatch = line.match(/^def\s+(\w+)\(([^)]*)\):/);
      if (functionMatch) functions[functionMatch[1]] = { params: functionMatch[2].split(',').map((param) => param.trim()).filter(Boolean), line: index + 1 };
    });
    const interpolate = (value) => value.replace(/\{(\w+)\}/g, (_, key) => variables[key] === undefined ? '' : variables[key]);
    lines.forEach((rawLine, index) => {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || /^def\s/.test(line) || /^(if|return)\b/.test(line) || rawLine.startsWith('    ')) return;
      const assignment = line.match(/^(\w+)\s*=\s*(.+)$/);
      if (assignment) {
        const call = assignment[2].match(/^(\w+)\((.*)\)$/);
        if (call && functions[call[1]]) {
          const arg = parseLiteral(call[2], variables);
          const functionName = call[1];
          const messageLine = lines.find((candidate) => candidate.trim().startsWith('message ='));
          const template = messageLine ? messageLine.trim().replace(/^message\s*=\s*/, '') : '""';
          const unquoted = template.replace(/^f?["']|["']$/g, '');
          variables[assignment[1]] = interpolate(unquoted.replace(/\{\w+\}/g, `{${functions[functionName].params[0] || 'value'}}`).replace(new RegExp(`\\{${functions[functionName].params[0] || 'value'}\\}`, 'g'), String(arg)));
        } else variables[assignment[1]] = parseLiteral(assignment[2], variables);
        events.push({ sequence: events.length, type: 'line', line: index + 1, variables: { ...variables }, call_stack: [] });
      }
      const printMatch = line.match(/^print\((.*)\)$/);
      if (printMatch) {
        const value = parseLiteral(printMatch[1], variables);
        output.push(String(value));
        events.push({ sequence: events.length, type: 'stdout', line: index + 1, output: String(value), variables: { ...variables }, call_stack: [] });
      }
      if (/^(\w+)\s*=/.test(line) && !assignment) diagnostics.push({ title: `Could not parse line ${index + 1}`, detail: 'Use a simple assignment in offline mode.' });
    });
    return { output, variables, diagnostics, events, lines: lines.length, status: diagnostics.length ? 'error' : 'completed' };
  }

  async function callApi(endpoint, payload) {
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setApiStatus(true);
      return await response.json();
    } catch (error) {
      setApiStatus(false);
      return null;
    }
  }

  async function runCode(options = {}) {
    if (state.termRunning) return;
    const fresh = options.fresh !== false;
    if (fresh) {
      state.termEntries = [];
      state.termShown = [];
      state.awaitingInput = false;
      if (options.resetInput !== false) state.stdinLines = [];
      renderTerminal();
    }
    const source = $('code-editor').value;
    state.lastStdin = (state.stdinLines || []).join('\n');
    state.termRunning = true;
    setText('run-status', 'Running…');
    setText('run-time', 'now');
    updatePromptState();
    const result = await callApi('/api/execute', { language: state.language, code: source, stdin: state.lastStdin });
    state.termRunning = false;
    if (result) {
      applyExecution(result, source, fresh);
    } else if (state.language === 'python') {
      const fallback = offlinePython(source);
      renderConsole(fallback.output, true);
      renderVariables(fallback.variables);
      renderDiagnostics(fallback.diagnostics, fallback.diagnostics.length === 0);
      renderTrace(fallback, source);
      renderLimits(null);
      setText('run-status', fallback.status === 'unsupported' ? 'Not executed · offline subset boundary' : 'Complete · offline fallback');
    } else {
      renderConsole(['API unavailable. Switch to Python for the offline fallback.'], true);
      renderTrace({ status: 'error', events: [], variables: {}, call_stack: [] }, source);
      renderLimits(null);
      renderVariables({});
      renderDiagnostics([{ title: 'Execution service unavailable', detail: 'The JavaScript offline fallback is not enabled.' }], false);
      setText('run-status', 'Could not run');
    }
    updatePromptState();
    if (state.awaitingInput) {
      const prompt = $('terminal-input');
      if (prompt) prompt.focus();
    }
  }

  function applyExecution(result, source, fresh) {
    const lines = executeOutputLines(result);
    const allDiagnostics = result.diagnostics || result.errors || [];
    const waiting = isWaitingForInput(result);

    // The service restarts the program for every request, so each response
    // repeats the output from line 1. Keep the common prefix and append only
    // the new tail — that is what makes it read as one continuous session.
    let keep = 0;
    if (!fresh) {
      const shown = state.termShown || [];
      while (keep < shown.length && keep < lines.length && shown[keep] === lines[keep]) keep += 1;
    }
    lines.slice(keep).forEach((line) => pushTerm('out', line));
    state.termShown = lines;
    state.lastOutput = lines;

    const realDiagnostics = allDiagnostics.filter((item) => item && item.kind !== 'unsupported' && !isEofDiagnostic(item));
    if (waiting) {
      state.awaitingInput = true;
      setText('run-status', 'Waiting for input');
    } else {
      state.awaitingInput = false;
      const stderrLines = String(result.stderr || '').split('\n').filter(Boolean);
      if (stderrLines.length) stderrLines.forEach((line) => pushTerm('err', line));
      else realDiagnostics.forEach((item) => pushTerm('err', `${item.title || 'Error'}${item.line ? ` (line ${item.line})` : ''}: ${item.message || item.detail || ''}`.trim()));
    }
    renderTerminal();
    renderVariables(result.variables || {});
    renderTrace(result, source);
    renderLimits(result);
    const passed = result.status === 'completed' && realDiagnostics.length === 0;
    // A program blocked on input() has not failed: report "no issues" so the
    // diagnostics panel does not shout about the EOF signal.
    renderDiagnostics(realDiagnostics, waiting ? true : passed);
    setText('run-time', result.duration_ms ? `${Math.round(result.duration_ms)} ms` : 'now');
    // Set last: renderTrace() drives the timeline and rewrites this label.
    setText('run-status', waiting ? 'Waiting for input' : passed ? 'Execution complete' : `Execution stopped · ${result.status || 'issues found'}`);
  }

  function explainAiPanel() { return document.querySelector('.explain-ai-panel'); }

  function expandExplainAi(open) {
    const panel = explainAiPanel();
    const body = $('ai-explain-body');
    const toggle = $('explain-ai-toggle');
    if (body) body.classList.toggle('hidden', !open);
    if (panel) panel.classList.toggle('open', open);
    if (toggle) toggle.setAttribute('aria-expanded', String(open));
  }

  function flashExplainAi() {
    const panel = explainAiPanel();
    if (panel) { panel.classList.add('explain-flash'); setTimeout(() => panel.classList.remove('explain-flash'), 1400); if (panel.scrollIntoView) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  }

  async function explainInPanel() {
    const box = $('ai-explain-text');
    const event = (state.trace && state.trace.length) ? (state.trace[state.step] || null) : null;
    const hasStep = Boolean(event);
    // AI lives in its own expandable section (not the "What happened" panel)
    // and is only ever fetched here, when the user presses Explain.
    expandExplainAi(true);
    if (box) { box.textContent = 'Thinking…'; box.classList.add('explaining'); }
    if (hasStep && event && event.type === 'input') {
      if (box) { box.textContent = eventExplanation(event, [], false); box.classList.remove('explaining'); }
      flashExplainAi();
      return;
    }
    const payload = hasStep
      ? { ...aiContext('Explain, in plain simple language for a beginner programmer, exactly what happens at this execution step. Refer to the source line and any variable values shown in the evidence. Keep it to 2–3 short sentences — no code fences, no headings.'), mode: 'explain-step', selected_event: event }
      : { ...aiContext('Analyze this code and its current execution evidence.'), mode: 'analyze' };
    const result = await callApi('/api/ai', payload);
    if (box) box.classList.remove('explaining');
    if (!result) {
      if (box) box.textContent = 'The AI service could not be reached. Check the connection or the provider configuration.';
      return;
    }
    if (result.status === 'ok' && typeof (result.answer || result.response) === 'string') {
      if (box) box.textContent = (result.answer || result.response).trim();
      setAiProviderStatus('remote', hasStep ? 'Remote AI · step explained' : 'Remote AI · code explained');
      flashExplainAi();
    } else if (result.status === 'not-configured') {
      if (box) box.textContent = result.message || 'AI is not configured. Set CODEFLOW_AI_API_KEY on the backend.';
      setAiProviderStatus('notConfigured', 'Not configured · no explanation generated');
    } else {
      if (box) box.textContent = result.message || 'The AI provider returned an error.';
      setAiProviderStatus('error', 'Remote AI · provider error');
    }
  }

  async function verifyCode() {
    const source = $('code-editor').value;
    setText('run-status', 'Verifying…');
    const result = await callApi('/api/verify', { language: state.language, code: source });
    if (result) {
      const passed = result.valid !== false && result.passed !== false;
      renderDiagnostics(passed ? [] : (result.errors || [{ title: 'Verification failed', detail: 'Review the reported issue.' }]), passed);
      setText('run-status', passed ? 'Verified' : 'Verification found issues');
      showToast(passed ? 'Verification passed.' : 'Verification found an issue.');
    } else {
      const fallback = offlinePython(source);
      renderDiagnostics(fallback.diagnostics, fallback.diagnostics.length === 0);
      setText('run-status', fallback.diagnostics.length ? 'Verification found issues · offline' : 'Verified · offline');
      showToast('API unavailable — verified with local checks.');
    }
  }

  function updateTimeline() {
    const steps = all('.flow-step');
    if (!steps.length) {
      setText('step-count', '0 / 0');
      const bar = $('timeline-progress');
      const thumb = $('timeline-thumb');
      if (bar) bar.style.width = '0%';
      if (thumb) thumb.style.left = '0%';
      renderSelectedEvent();
      return;
    }
    steps.forEach((step, index) => step.classList.toggle('active', index === state.step));
    const activeStep = steps[state.step];
    const flowMap = $('flow-map');
    if (activeStep && flowMap && flowMap.scrollWidth > flowMap.clientWidth) {
      // Keep the active step centred, otherwise playback walks the highlight
      // off the right edge and the animation looks frozen.
      const target = activeStep.offsetLeft - (flowMap.clientWidth - activeStep.offsetWidth) / 2;
      flowMap.scrollTo({ left: Math.max(0, target), behavior: 'smooth' });
    }
    const progress = state.step / (steps.length - 1 || 1) * 100;
    const bar = $('timeline-progress');
    const thumb = $('timeline-thumb');
    if (bar) bar.style.width = `${progress}%`;
    if (thumb) thumb.style.left = `${progress}%`;
    setText('step-count', `${state.step + 1} / ${steps.length}`);
    renderSelectedEvent();
    dispatchStep();
  }

  function dispatchStep() {
    try {
      window.dispatchEvent(new CustomEvent('codeflow:step', {
        detail: {
          step: state.step,
          events: state.trace,
          source: state.executedSource || state.source,
          language: state.language
        }
      }));
    } catch (_) { /* CustomEvent is optional */ }
  }

  function selectTimelineStep(step, playSound = false) {
    const length = all('.flow-step').length;
    if (!length) return;
    const nextStep = Math.max(0, Math.min(length - 1, step));
    const changed = nextStep !== state.step;
    state.step = nextStep;
    updateTimeline();
    if (playSound && (changed || state.trace[state.step])) playStepSound(state.trace[state.step]);
  }

  function moveTimeline(delta) {
    const length = all('.flow-step').length;
    if (!length) return;
    selectTimelineStep(state.step + delta, true);
    setText('run-status', `Viewing step ${state.step + 1}`);
  }

  function togglePlayback() {
    if (!all('.flow-step').length) {
      showToast('No execution events are available to play.');
      return;
    }
    state.playing = !state.playing;
    const button = $('play-button');
    if (button) button.textContent = state.playing ? 'Ⅱ' : '▶';
    window.clearInterval(state.timer);
    if (state.playing) {
      state.timer = window.setInterval(() => {
        if (state.step >= all('.flow-step').length - 1) { state.step = -1; }
        moveTimeline(1);
      }, 1200);
    }
  }

  function importCode(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { $('code-editor').value = String(reader.result || ''); updateLineNumbers(); updateCursor(); saveSnapshot(); showToast(`Imported ${file.name}.`); };
    reader.onerror = () => showToast('Could not read that file.');
    reader.readAsText(file);
  }

  function exportCode() {
    const blob = new Blob([$('code-editor').value], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = `codeflow-${fileNameFor(state.language)}`;
    document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
    showToast('Code exported.');
  }

  async function askAi(prompt) {
    if (!prompt) return;
    setText('ai-response', 'Thinking about your code…');
    setAiProviderStatus('notConfigured', 'Sending code, diagnostics, selected event, and prompt to /api/ai');
    renderAiProposal(null);
    const result = await callApi('/api/ai', aiContext(prompt));
    if (!result) {
      setText('ai-response', localAiFallback(prompt));
      setAiProviderStatus('local', 'Local fallback · the backend could not be reached');
      return;
    }
    if (result.status === 'ok' && typeof (result.answer || result.response) === 'string') {
      setText('ai-response', result.answer || result.response);
      renderAiProposal(result.proposed_code);
      setAiProviderStatus('remote', result.proposed_code ? 'Remote AI · answer and proposed code received' : 'Remote AI · answer received');
      return;
    }
    renderAiProposal(null);
    if (result.status === 'not-configured') {
      setText('ai-response', result.message || 'AI is not configured. Set CODEFLOW_AI_API_KEY on the backend.');
      setAiProviderStatus('notConfigured', 'Not configured · no remote answer was generated');
    } else {
      const diagnostic = Array.isArray(result.diagnostics) && result.diagnostics[0];
      setText('ai-response', result.message || 'The remote AI provider returned an error. Review the provider diagnostics.');
      setAiProviderStatus('error', `Remote AI · provider error${diagnostic && diagnostic.detail ? `: ${diagnostic.detail}` : ''}`);
    }
  }

  function loadExample(name, language) {
    const editor = $('code-editor');
    if (!editor) return;
    const requested = language || state.exampleLanguage || state.language;
    const target = EXAMPLES[name] && EXAMPLES[name][requested] ? requested : state.language;
    const source = exampleSource(name, target);
    if (!source) return;
    const changed = target !== state.language;
    state.example = name;
    editor.value = source;
    state.source = source;
    applyLanguage(target);
    updateLineNumbers();
    updateCursor();
    saveSnapshot();
    if (changed) resetTrace();
    showToast(`${EXAMPLE_TITLES[name] || name} example loaded in ${LANGUAGE_LABELS[target] || target}.`);
  }

  function bindEvents() {
    const editor = $('code-editor');
    editor.addEventListener('input', () => { state.example = null; updateLineNumbers(); updateCursor(); saveSnapshot(); });
    editor.addEventListener('scroll', syncHighlightScroll, { passive: true });
    ['keyup', 'click', 'select'].forEach((event) => editor.addEventListener(event, updateCursor));
    editor.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        runCode();
      }
    });
    $('run-button').addEventListener('click', () => runCode());
    $('analyze-button').addEventListener('click', explainInPanel);
    $('verify-button').addEventListener('click', verifyCode);
    $('stdin-button').addEventListener('click', () => {
      if (!openInputDialog()) {
        const ti = $('terminal-input');
        if (ti) ti.focus();
      }
    });
    $('stdin-close').addEventListener('click', () => $('stdin-modal').classList.add('hidden'));
    $('stdin-done').addEventListener('click', applyInputDialog);
    $('stdin-clear').addEventListener('click', () => { $('stdin-input').value = ''; $('stdin-input').focus(); });
    const terminalInput = $('terminal-input');
    if (terminalInput) terminalInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      // Enter feeds the waiting program; Ctrl/Cmd+Enter always restarts it.
      if (event.metaKey || event.ctrlKey) runCode(); else submitTerminalLine();
    });
    const terminalSend = $('terminal-send');
    if (terminalSend) terminalSend.addEventListener('click', submitTerminalLine);
    $('explain-ai-toggle').addEventListener('click', () => expandExplainAi(Boolean($('ai-explain-body') && $('ai-explain-body').classList.contains('hidden'))));
    $('stdin-modal').addEventListener('click', (event) => { if (event.target === $('stdin-modal')) $('stdin-modal').classList.add('hidden'); });
    $('previous-step').addEventListener('click', () => moveTimeline(-1));
    $('next-step').addEventListener('click', () => moveTimeline(1));
    $('play-button').addEventListener('click', togglePlayback);
    $('sound-toggle').addEventListener('click', toggleSound);
    $('reset-timeline').addEventListener('click', () => { selectTimelineStep(0, true); setText('run-status', 'Waiting for your code'); });
    $('flow-map').addEventListener('click', (event) => {
      const step = event.target.closest('.flow-step');
      if (!step) return;
      selectTimelineStep(Number(step.dataset.step) || 0, true);
    });
    $('diagnostics-output').addEventListener('click', (event) => {
      const item = event.target.closest('[data-line]');
      if (item) focusSourceLine(item.dataset.line);
    });
    $('diagnostics-output').addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const item = event.target.closest('[data-line]');
      if (!item) return;
      event.preventDefault();
      focusSourceLine(item.dataset.line);
    });
    $('clear-console').addEventListener('click', () => { state.stdinLines = []; state.lastStdin = ''; state.awaitingInput = false; state.termShown = []; state.termEntries = []; renderTerminal(); updatePromptState(); const ti = $('terminal-input'); if (ti) ti.focus(); });
    $('find-button').addEventListener('click', () => { $('find-bar').classList.remove('hidden'); $('find-input').focus(); });
    $('close-find').addEventListener('click', () => $('find-bar').classList.add('hidden'));
    $('replace-button').addEventListener('click', () => replaceText(false));
    $('replace-all-button').addEventListener('click', () => replaceText(true));
    $('theme-toggle').addEventListener('click', () => { document.body.classList.toggle('light'); showToast(document.body.classList.contains('light') ? 'Light theme enabled.' : 'Dark theme enabled.'); });
    $('import-button').addEventListener('click', () => $('file-input').click());
    $('file-input').addEventListener('change', (event) => importCode(event.target.files[0]));
    $('export-button').addEventListener('click', exportCode);
    $('share-button').addEventListener('click', shareCode);
    $('restore-button').addEventListener('click', () => {
      if (!state.snapshot) return showToast('Nothing has been saved yet.');
      editor.value = state.snapshot;
      state.source = state.snapshot;
      updateLineNumbers(); updateCursor();
      showToast('Restored the last saved version.');
    });
    $('undo-button').addEventListener('click', () => {
      // Flush any pending edit first, otherwise undo would discard the
      // previous restore point instead of the current state.
      commitSnapshot();
      if (state.history.length > 1) {
        state.history.pop();
        const previous = state.history[state.history.length - 1];
        editor.value = previous;
        state.source = previous;
        updateLineNumbers(); updateCursor();
        showToast('Undid the last change.');
      } else showToast('Nothing to undo yet.');
    });
    const languageTabs = $('language-tabs');
    if (languageTabs) {
      languageTabs.addEventListener('click', (event) => {
        const tab = event.target.closest('.lang-tab');
        if (!tab) return;
        const next = tab.dataset.language;
        const changed = next !== state.language;
        applyLanguage(next);
        updateCursor();
        saveSnapshot();
        if (changed) resetTrace();
        const label = tab.querySelector('.lang-name');
        showToast(`${(label ? label.textContent : tab.textContent).trim()} selected.`);
      });
    }
    $('ai-button').addEventListener('click', () => { const input = $('ai-input'); askAi(input.value.trim()); input.value = ''; });
    $('ai-input').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); $('ai-button').click(); } });
    all('.chip').forEach((chip) => chip.addEventListener('click', () => askAi(chip.dataset.prompt)));
    all('[data-example]').forEach((link) => link.addEventListener('click', () => loadExample(link.dataset.example, state.exampleLanguage)));
    const exampleLangs = $('example-langs');
    if (exampleLangs) {
      exampleLangs.addEventListener('click', (event) => {
        const button = event.target.closest('.example-lang');
        if (!button) return;
        const next = button.dataset.language;
        if (!FILE_NAMES[next]) return;
        const changed = next !== state.language;
        applyLanguage(next);
        updateCursor();
        saveSnapshot();
        if (changed) resetTrace();
        showToast(`Examples now shown in ${LANGUAGE_LABELS[next] || next}.`);
      });
    }
    $('mobile-menu').addEventListener('click', () => { const nav = document.querySelector('.main-nav'); const open = nav.classList.toggle('mobile-open'); $('mobile-menu').setAttribute('aria-expanded', String(open)); });
    all('.nav-link').forEach((link) => link.addEventListener('click', () => document.querySelector('.main-nav').classList.remove('mobile-open')));

    // Three views. The page opens on the hero only; the workspace and the
    // FlowMind panel appear after "Open visualizer", and Examples is its own
    // page rather than a strip under the editor. Anchors are handled here
    // rather than by the browser because the target section is display:none
    // until the class flips, so a native jump would land on nothing.
    const APP_SECTIONS = ['#visualizer', '#learn'];
    const PAGE_SECTIONS = ['#examples'];
    const ROUTES = APP_SECTIONS.concat(PAGE_SECTIONS);

    function showSection(hash, push) {
      const home = hash === '#home' || hash === '#' || !hash;
      const target = home ? '#home' : hash;
      const appView = APP_SECTIONS.indexOf(target) !== -1;
      const examplesView = PAGE_SECTIONS.indexOf(target) !== -1;
      document.body.classList.toggle('app-view', appView);
      document.body.classList.toggle('examples-view', examplesView);
      all('.nav-link').forEach((link) => link.classList.toggle('active', link.getAttribute('href') === target));
      // pushState (not replace) so the browser Back button walks back to the
      // landing instead of leaving the site.
      if (push && history.pushState && location.hash !== target) history.pushState(null, '', target);
      if (home) {
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      // #examples is a whole page, so it opens at the top; #learn is a section
      // inside the workspace and needs scrolling to.
      if (examplesView) {
        requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
        return;
      }
      const section = document.querySelector(target);
      if (section) requestAnimationFrame(() => section.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }

    document.addEventListener('click', (event) => {
      const link = event.target.closest ? event.target.closest('a[href^="#"]') : null;
      if (!link) return;
      const hash = link.getAttribute('href');
      if (!hash || (hash !== '#home' && ROUTES.indexOf(hash) === -1)) return;
      event.preventDefault();
      showSection(hash, true);
      const nav = document.querySelector('.main-nav');
      if (nav) nav.classList.remove('mobile-open');
      const menu = $('mobile-menu');
      if (menu) menu.setAttribute('aria-expanded', 'false');
    });

    window.addEventListener('popstate', () => showSection(location.hash || '#home', false));

    // A shared link straight to a section should open in the right view.
    if (ROUTES.indexOf(location.hash) !== -1) showSection(location.hash, false);
  }

  function replaceText(allMatches) {
    const editor = $('code-editor');
    const find = $('find-input').value;
    if (!find) return showToast('Enter text to find first.');
    const replacement = $('replace-input').value;
    if (allMatches) editor.value = editor.value.split(find).join(replacement);
    else { const index = editor.value.indexOf(find); if (index >= 0) editor.setRangeText(replacement, index, index + find.length, 'select'); }
    updateLineNumbers(); updateCursor(); saveSnapshot(); showToast(allMatches ? 'All matches replaced.' : 'First match replaced.');
  }

  function start() {
    try {
      const editor = $('code-editor');
      // Restore the language alongside the code, otherwise a reload sends C++
      // source to the Python interpreter.
      let savedLanguage = '';
      try { savedLanguage = localStorage.getItem('codeflow.language') || ''; } catch (_) { /* persistence is optional */ }
      const restoredLanguage = _normalize(savedLanguage);
      // Always applied, even when nothing was saved, so the header, tabs and
      // file dot agree with each other on the very first paint.
      applyLanguage(restoredLanguage || state.language);
      const fromLink = applyShareLink();
      if (!fromLink) {
        let saved = '';
        try { saved = localStorage.getItem('codeflow.source') || ''; } catch (_) { /* persistence is optional */ }
        if (editor && saved) editor.value = saved;
      }
      state.source = editor ? editor.value : '';
      state.snapshot = state.source;
      state.history = [state.source];
      updateLineNumbers(); updateCursor(); updateTimeline(); bindEvents(); configureSoundSupport(); refreshHealth(); renderTerminal(); updatePromptState();
      window.CodeFlow = {
        snapshot: () => ({
          step: state.step,
          events: state.trace,
          source: state.executedSource || state.source,
          language: state.language,
          // The lesson's output panel reads these: the trace events only carry
          // per-step `output` for languages whose tracer emits it (Python, and
          // the offline fallback), so the full program output is passed through
          // as a fallback for C/C++/Java and as the progressive accumulator.
          output: (state.lastResult && Array.isArray(state.lastResult.output)) ? state.lastResult.output : [],
          stdout: (state.lastResult && typeof state.lastResult.stdout === 'string') ? state.lastResult.stdout : '',
          stderr: (state.lastResult && typeof state.lastResult.stderr === 'string') ? state.lastResult.stderr : ''
        }),
        hasTrace: () => state.trace.length > 0,
        // True while the last run stopped on input(). The animated stage uses
        // this to ask for the values instead of replaying a four-step nothing.
        needsInput: () => Boolean(state.awaitingInput),
        openInputDialog: () => openInputDialog(),
        // The animation stage titles itself after the example on screen, so
        // "Selection sort" reads better than a generic "Animated run".
        exampleTitle: () => (state.example && EXAMPLE_TITLES[state.example]) ? EXAMPLE_TITLES[state.example] : '',
        run: () => runCode(),
        goToStep: (index) => {
          state.playing = false;
          window.clearInterval(state.timer);
          const playButton = $('play-button');
          if (playButton) playButton.textContent = '▶';
          selectTimelineStep(index, false);
        }
      };
    } catch (error) {
      // Keep the page usable even if a browser extension changes the DOM.
      setText('run-status', 'Ready — some optional controls are unavailable');
      showToast('CodeFlow loaded with limited controls.');
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
