// ─── Candidate gender auto-tagging — first-name based, India-focused ──────────
//
// RESEARCH NOTE (methodology): Indian given names don't follow one convention
// — they vary by region, religion, and language (Hindi/Sanskrit-derived,
// Punjabi/Sikh, Muslim/Urdu, Bengali, Gujarati, Marathi, Tamil, Telugu,
// Kannada, Malayalam, Parsi, Christian/Anglo-Indian), so no single suffix
// rule works across all of them. This module uses a two-tier approach:
//
//   1. A curated dictionary of several hundred names actually common across
//      those communities (below), built from general knowledge of Indian
//      naming patterns — the primary, most reliable signal.
//   2. A SMALL set of high-confidence suffix heuristics for names the
//      dictionary doesn't cover (e.g. "-ika"/"-ita"/"-ini" endings are
//      reliably feminine; "-esh"/"-endra"/"-eshwar" endings are reliably
//      masculine) — used only as a fallback, and deliberately conservative.
//
// What this deliberately does NOT do: force a guess on a name it isn't
// confident about. Real unisex/ambiguous Indian names (Kiran, Simran,
// Amanpreet, Manpreet, Jaspreet, and similar "-preet"/"-jit"/"-jeet" Sikh
// compounds that go either way) are explicitly excluded from both dictionary
// buckets so they fall through to `null` ("Unknown") rather than being
// silently mis-tagged — gender is a sensitive attribute, and a wrong tag is
// worse than an honest "don't know." `null` is a first-class result, not a
// bug: every call site (auto-tag on create, backfill script, UI) must treat
// it as a real, displayable "Unknown" state, filterable like M/F, never
// coerced to one or the other.
//
// This is inherently a heuristic, not a certainty — a name absent from the
// dictionary and not matching a suffix rule returns null, and even a
// dictionary hit can occasionally be wrong for an individual (names cross
// gender lines more often than most heuristics assume). Treat the resulting
// `candidates.gender` column as a best-effort tag for aggregate
// filtering/reporting, not a verified attribute — HR can always correct it
// manually (it's a plain editable field once set, not read-only).

export type Gender = 'M' | 'F';

// Titles/prefixes stripped before taking the first whitespace-separated
// token as the "first name" — full_name arrives as free text from forms/
// Excel imports and commonly carries one of these.
const TITLE_PREFIXES = [
  'mr', 'mrs', 'ms', 'miss', 'dr', 'er', 'eng', 'prof', 'shri', 'sri', 'smt',
  'kumari', 'md', 'mohd', 'mohammed', 'capt', 'col', 'major', 'adv',
];

export function extractFirstName(fullName: string | null | undefined): string | null {
  if (!fullName) return null;
  const tokens = fullName
    .trim()
    .split(/\s+/)
    .map(t => t.replace(/[.,]/g, ''))
    .filter(Boolean);

  let i = 0;
  while (i < tokens.length && TITLE_PREFIXES.includes(tokens[i].toLowerCase())) i++;
  const first = tokens[i];
  return first ? first.toLowerCase() : null;
}

// ─── Dictionary — Male ──────────────────────────────────────────────────────
// Organized by community/region for maintainability, not because the
// classifier treats them differently. Includes common variant spellings
// (Amit/Amith, Rohit/Rohith) as separate entries mapping to the same result.
const MALE_NAMES = new Set([
  // North Indian / Hindi / Sanskrit-derived — classic and modern
  'aakash', 'akash', 'aarav', 'aarush', 'aayush', 'aayan', 'abhay', 'abhijeet', 'abhijit',
  'abhinav', 'abhishek', 'aditya', 'advait', 'ajay', 'akhil', 'akshay', 'akshat', 'alok',
  'aman', 'amar', 'amit', 'amith', 'anand', 'anay', 'aniket', 'anil', 'ankit', 'ankur', 'ankush',
  'anmol', 'anoop', 'anshuman', 'anubhav', 'anup', 'anurag', 'arjun', 'arnav', 'arun', 'arvind',
  'aryan', 'ashish', 'ashok', 'ashutosh', 'atul', 'avinash', 'ayush', 'adarsh', 'akarsh',
  'balram', 'bharat', 'bhaskar', 'bhavesh', 'bhupendra',
  'bhuvan', 'chetan', 'darshan', 'deepak', 'dev', 'devansh', 'devendra', 'dhaval', 'dheeraj',
  'dhruv', 'dinesh', 'divyansh', 'gagan', 'ganesh', 'gaurav', 'girish', 'gopal', 'gyan',
  'harendra', 'harsh', 'harshit', 'harshvardhan', 'hemant', 'himanshu', 'hitesh', 'ishaan',
  'jatin', 'jayant', 'jayaprakash', 'jayesh', 'jitendra', 'kabir', 'kailash', 'kamal', 'kanav', 'karan',
  'kshitij', 'kushal',
  'kartik', 'karthik', 'kaushal', 'keshav', 'kishore', 'krishna', 'kunal', 'lakshya', 'lalit',
  'lokesh', 'mahesh', 'manav', 'manish', 'manoj', 'mayank', 'mohan', 'mohit', 'mukesh',
  'nakul', 'naman', 'narendra', 'naresh', 'naveen', 'navin', 'nikhil', 'nilesh', 'niraj', 'nirmal',
  'nishant', 'nitesh', 'nitin', 'om', 'omkar', 'pankaj', 'paras', 'parth', 'pawan', 'piyush',
  'prabhat', 'prabhu', 'pradeep', 'pramod', 'pranav', 'prashant', 'prateek', 'pratik',
  'praveen', 'pravin', 'punit', 'puneet', 'purushottam', 'rahul', 'raj', 'rajat', 'rajeev',
  'rajendra', 'rajesh', 'rajiv', 'rajkumar', 'raju', 'rakesh', 'raman', 'ramesh', 'ranjan',
  'ranjit', 'ratan', 'raunak', 'rounak', 'ravi', 'ravindra', 'rishab', 'rishabh', 'ritesh', 'rohan',
  'rohit', 'rohith', 'ronak', 'rudra', 'sachin', 'sagar', 'sahil', 'sameer', 'samir', 'sandeep',
  'samarth', 'sanjay', 'sanjeev', 'santosh', 'satish', 'satyendra', 'saurabh', 'sourav', 'shaurya', 'shailendra',
  'shankar', 'shashank', 'shashi', 'shiv', 'shivam', 'shubham', 'shyam', 'siddharth',
  'sohan', 'somesh', 'subhash', 'subodh', 'sudarshan', 'sudhanshu', 'sudhir', 'sumit',
  'sunder', 'sundeep', 'sunil', 'suraj', 'surendra', 'suresh', 'suryakant', 'sushant',
  'swapnil', 'tanmay', 'tarun', 'tejas', 'udayan', 'uday', 'umang', 'umesh', 'upendra',
  'utkarsh', 'utsav', 'vaibhav', 'vansh', 'varun', 'veer', 'vibhor', 'vijay', 'vikas', 'vikram',
  'vikrant', 'vimal', 'vinay', 'vineet', 'vinit', 'vinod', 'vipin', 'vipul', 'vishal',
  'vishnu', 'vivek', 'yash', 'yashwant', 'yatin', 'yogendra', 'yogesh', 'yuvraj',
  // Sikh/Punjabi (skewing/exclusively male forms — see exclusions below for
  // the genuinely unisex "-preet"/"-jeet" compounds)
  'amarjeet', 'amarjit', 'amritpal', 'baljinder', 'balbir', 'balwinder', 'bikram', 'gurbaksh',
  'gurcharan', 'gurdeep', 'gurjeet', 'gurmail', 'gurnam', 'gursimran', 'harbhajan', 'hardeep',
  'harinder', 'harjinder', 'harpal', 'harshdeep', 'harvinder', 'inderjeet', 'inderjit', 'jagdeep', 'jagjit',
  'jagmohan', 'jarnail', 'jaskaran', 'jasvinder', 'jaswant', 'jatinder', 'jogindar', 'kuldeep',
  'kulwinder', 'lakhbir', 'lakhvinder', 'mandeep', 'manjinder', 'manjot', 'narinder',
  'parminder', 'ranbir', 'sandeep', 'satnam', 'sukhbir', 'sukhdev', 'sukhjinder', 'sukhwinder',
  'surjeet', 'surinder', 'tarlochan', 'tejinder', 'yadwinder',
  // Muslim / Urdu
  'aamir', 'aarif', 'aasif', 'adnan', 'ahmed', 'ahsan', 'akbar', 'akhtar', 'ali', 'altaf',
  'amaan', 'amjad', 'anwar', 'arbaaz', 'arif', 'arshad', 'asad', 'ashfaq', 'asif', 'ayaan',
  'ayub', 'azad', 'azhar', 'bilal', 'danish', 'ehsaan', 'faisal', 'farhan', 'fardeen', 'farid',
  'farooq', 'fayaz', 'firoz', 'ghulam', 'hamid', 'hamza', 'haroon', 'hasan', 'hassan',
  'hussain', 'ibrahim', 'imran', 'imtiaz', 'iqbal', 'irfan', 'ishaan', 'ismail', 'javed',
  'kaif', 'kamal', 'kamran', 'kashif', 'khalid', 'liaquat', 'mahmood', 'mansoor', 'mehboob',
  'mohsin', 'mubarak', 'mukhtar', 'munir', 'mustafa', 'nadeem', 'nasir', 'nawaz', 'nazim',
  'nizam', 'noman', 'omar', 'parvez', 'qadir', 'rafiq', 'rashid', 'raza', 'rizwan', 'saad',
  'sagheer', 'sajid', 'salaam', 'saleem', 'salim', 'salman', 'sameer', 'sarfaraz', 'shabbir',
  'shadab', 'shahbaz', 'shahid', 'shahnawaz', 'shahrukh', 'shakeel', 'shamim', 'shariq',
  'shoaib', 'sikandar', 'sohail', 'suhail', 'tabrez', 'tahir', 'tanveer', 'tariq', 'tauseef',
  'wahid', 'waqar', 'wasim', 'yaseen', 'yasin', 'younus', 'yusuf', 'zaheer', 'zahid', 'zain',
  'zakir', 'zeeshan',
  // Bengali
  'abhijit', 'amitava', 'anirban', 'ansuman', 'arindam', 'ashoke', 'asit', 'barun', 'biman',
  'biplab', 'debashish', 'debjit', 'debojit', 'dipak', 'diptesh', 'gautam', 'gopinath',
  'indranil', 'jayanta', 'joydeep', 'kaushik', 'koushik', 'malay', 'mrinal', 'partha',
  'prasenjit', 'pritam', 'rajarshi', 'rananjay', 'ranajit', 'ranjan', 'sabyasachi',
  'sanjib', 'sayan', 'sekhar', 'shantanu', 'shubhankar', 'somnath', 'soumen', 'soumik',
  'soumitra', 'souvik', 'subhankar', 'subhas', 'subhro', 'sudip', 'sugato', 'suman',
  'sumanta', 'sumit', 'suvojit', 'tanmoy', 'tapan', 'tathagata',
  // Gujarati / Marathi
  'ajit', 'amol', 'anant', 'ashwin', 'bhargav', 'chirag', 'chintan', 'devang', 'dhiraj',
  'dhruvin', 'gopalkrishna', 'harsh', 'hemal', 'hitesh', 'jay', 'jayraj', 'jignesh',
  'kalpesh', 'ketan', 'khushal', 'kiran', 'krunal', 'mihir', 'milan', 'mitesh', 'mrunal',
  'nayan', 'nilay', 'nimesh', 'nirav', 'nishith', 'parag', 'parimal', 'parth', 'pratham',
  'rajan', 'rushabh', 'sagar', 'samir', 'sanket', 'sarvesh', 'shailesh', 'sharad', 'siddhesh',
  'snehal', 'sujal', 'tejas', 'tushar', 'vatsal', 'vipul', 'vishwas', 'yagnesh',
  // South Indian — Tamil / Telugu / Kannada / Malayalam
  'anand', 'anbarasan', 'anbu', 'anirudh', 'arjun', 'arun', 'arvind', 'ashwin', 'balaji',
  'balamurugan', 'balasubramaniam', 'bharath', 'chandrasekhar', 'chandru', 'dinakaran',
  'elango', 'gopalakrishnan', 'gopinath', 'govind', 'guru', 'gurumurthy', 'harish',
  'jagadish', 'jayakumar', 'kannan', 'karthik', 'karthikeyan', 'kiran', 'krishnamurthy',
  'krishnan', 'kumar', 'madhavan', 'madhu', 'mahendran', 'manikandan', 'manoharan',
  'manohar', 'mohanraj', 'murali', 'murugan', 'muthu', 'nagarajan', 'naresh', 'narsimha',
  'natarajan', 'nataraj', 'naveen', 'niranjan', 'pandiarajan', 'prabhakaran', 'prabhu',
  'pradeep', 'praveen', 'rajagopal', 'rajendran', 'rajesh', 'rajkumar', 'raju',
  'ramachandran', 'ramakrishnan', 'ramanathan', 'ramesh', 'ranganathan', 'ravichandran',
  'ravikumar', 'sampath', 'sanjeev', 'saravanan', 'satheesh', 'satish', 'selvakumar',
  'selvam', 'senthil', 'senthilkumar', 'shankar', 'shanmugam', 'shivakumar', 'sivakumar',
  'sreekanth', 'sreenivas', 'srikanth', 'srinath', 'srinivas', 'srinivasan', 'subbu',
  'subramaniam', 'subramanian', 'sudhakar', 'sundar', 'sundaram', 'sundareshan', 'suresh',
  'surya', 'thangaraj', 'thiru', 'thiyagarajan', 'udayakumar', 'vasanth', 'vasudevan',
  'veeraraghavan', 'veerappan', 'vellingiri', 'venkatesan', 'venkatesh', 'venkataraman',
  'vignesh', 'vijayakumar', 'vijayan', 'vimal', 'vinayak', 'vishwanath', 'vivek', 'yogesh',
  // Parsi
  'adi', 'cyrus', 'darius', 'farokh', 'jamshed', 'jehangir', 'kaizad', 'khushru', 'noshir',
  'rustom', 'sohrab', 'zubin',
  // Christian / Anglo-Indian / Goan / North-Eastern common
  'alwyn', 'anthony', 'benjamin', 'clement', 'clifford', 'daniel', 'denzil', 'derek',
  'edwin', 'felix', 'francis', 'ivan', 'jerome', 'joel', 'john', 'joseph', 'joshua',
  'lawrence', 'leon', 'lester', 'lloyd', 'mathew', 'matthew', 'melvin', 'michael', 'nelson',
  'nigel', 'oscar', 'paul', 'peter', 'philip', 'ronald', 'roshan', 'russell', 'samuel',
  'simon', 'stanley', 'stephen', 'thomas', 'timothy', 'tony', 'vernon', 'victor', 'vincent',
  'walter', 'wilfred', 'william',
]);

// ─── Dictionary — Female ────────────────────────────────────────────────────
const FEMALE_NAMES = new Set([
  // North Indian / Hindi / Sanskrit-derived — classic and modern
  'aadhya', 'aadya', 'aaliya', 'aaradhya', 'aarohi', 'aarti', 'aashi', 'aditi', 'aishwarya',
  'akanksha', 'alka', 'amrita', 'anamika', 'ananya', 'anita', 'anjali', 'anju', 'ankita', 'ayushi',
  'anshika', 'anupama', 'anushka', 'aparna', 'archana', 'arpita', 'arti', 'arushi', 'asha',
  'ashima', 'avantika', 'avni', 'bhavana', 'bhavya', 'bhumi', 'chahat', 'chandni', 'charu',
  'charvi', 'darshana', 'deepa', 'deepali', 'deepika', 'deepti', 'devika', 'dimple', 'disha',
  'divya', 'diya', 'garima', 'gauri', 'gayatri', 'geeta', 'geetika', 'gita', 'gunjan',
  'hansa', 'hema', 'ishani', 'ishita', 'jaya', 'jayanti', 'jyoti', 'jyotsna', 'kajal',
  'kalpana', 'kamala', 'kanchan', 'kanika', 'kavita', 'kavya', 'khushi', 'kiran', 'komal',
  'kritika', 'kusum', 'lakshmi', 'lata', 'laxmi', 'madhavi', 'madhu', 'madhuri', 'mahi',
  'mala', 'malini', 'mamta', 'mandira', 'manisha', 'mansi', 'maya', 'meena', 'meenakshi',
  'meera', 'mina', 'mohini', 'monika', 'mrinalini', 'mugdha', 'mukta', 'myra', 'nandini',
  'nandita', 'natasha', 'navya', 'neelam', 'neelima', 'neena', 'neeraja', 'neerja', 'neeru',
  'neetu', 'neha', 'nidhi', 'niharika', 'nikita', 'nilima', 'nina', 'nirmala', 'nisha',
  'nishtha', 'nitya', 'niyati', 'padma', 'padmini', 'palak', 'pallavi', 'pari', 'parul',
  'parvati', 'payal', 'pinky', 'pooja', 'poonam', 'prachi', 'pragati', 'pragya', 'prakriti',
  'pratibha', 'preeti', 'prerna', 'priti', 'priya', 'priyanka', 'punam', 'purnima',
  'radha', 'radhika', 'rajni', 'rakhi', 'rama', 'rani', 'ranjana', 'ratna', 'reena', 'reeta',
  'rekha', 'renu', 'renuka', 'richa', 'riddhi', 'ritu', 'riya', 'ruchi', 'ruchika',
  'rashmi', 'rukmini', 'rupa', 'rupali', 'sadhana', 'sakshi', 'sana', 'sangeeta', 'sanjana',
  'sheetal', 'shibani',
  'sanskriti', 'sapna', 'saraswati', 'sarika', 'sarita', 'sarla', 'sarojini', 'saroj',
  'saumya', 'seema', 'shalini', 'shanta', 'shanti', 'sharda', 'sharmila', 'sharmistha',
  'shefali', 'shikha', 'shilpa', 'shipra', 'shivani', 'shraddha', 'shreya', 'shri',
  'shruti', 'shubhra', 'shweta', 'simran', 'sindhu', 'sita', 'smita', 'smriti', 'sneha',
  'snigdha', 'sonali', 'sonam', 'sonia', 'sudha', 'suhasini', 'suman', 'sumati', 'sumitra',
  'sunaina', 'sunanda', 'sunita', 'suparna', 'supriya', 'surabhi', 'sushila', 'sushma',
  'sveta', 'swati', 'tania', 'tanisha', 'tanu', 'tanuja', 'tanvi', 'tanya', 'tara',
  'trisha', 'trupti', 'uma', 'urmila', 'urvashi', 'usha', 'vaishali', 'vandana', 'vanita',
  'vanya', 'varsha', 'vasudha', 'veena', 'vibha', 'vidya', 'vimla', 'vineeta', 'vinita',
  'vrinda', 'yamini', 'yashika', 'yashoda', 'yashvi', 'zara',
  // Sikh/Punjabi (skewing/exclusively female forms)
  'amandeep', 'amreen', 'amrit', 'baljeet', 'gurleen', 'gurpreet', 'harleen', 'harmeet',
  'harsimran', 'inderpreet', 'jasleen', 'jaspreet', 'jasween', 'jyotpreet', 'kirandeep',
  'kirat', 'navdeep', 'navjot', 'navpreet', 'parneet', 'prabhleen', 'rajwinder', 'ramandeep',
  'ravneet', 'simran', 'sukhleen', 'taranjeet',
  // Muslim / Urdu
  'aaliya', 'aafreen', 'aaisha', 'aiman', 'aisha', 'alia', 'alina', 'amara', 'ambreen',
  'ameena', 'amina', 'amreen', 'anisa', 'arifa', 'asma', 'ayesha', 'azra', 'bushra',
  'chandni', 'faiza', 'farah', 'farheen', 'farida', 'farzana', 'fatima', 'firdaus', 'gulnaz',
  'hina', 'humaira', 'huma', 'iqra', 'ishrat', 'jahanara', 'kainat', 'kiran', 'khadija',
  'khushnuma', 'mahek', 'maheen', 'mahjabeen', 'mariam', 'maryam', 'mehjabeen', 'mehreen',
  'mehrunissa', 'misbah', 'mumtaz', 'naaz', 'nafisa', 'najma', 'nargis', 'nasreen', 'naushaba',
  'nazia', 'nazneen', 'nida', 'nikhat', 'nilofer', 'noorjahan', 'noor', 'parveen', 'raheela',
  'rakhshanda', 'rehana', 'rifat', 'roshni', 'rubina', 'rukhsana', 'rukhsar', 'rushda',
  'saba', 'sabiha', 'sadaf', 'sahar', 'saima', 'saira', 'salma', 'samina', 'samreen',
  'sana', 'sania', 'shabana', 'shabnam', 'shaheen', 'shahnaz', 'shaista', 'shakila',
  'shazia', 'sultana', 'tabassum', 'tahira', 'tanzeela', 'tasneem', 'yasmeen', 'yasmin',
  'zainab', 'zara', 'zarina', 'zeba', 'zoya',
  // Bengali
  'ananya', 'anindita', 'aparajita', 'aparna', 'baishakhi', 'barnali', 'bidisha', 'chaitali',
  'debarati', 'debolina', 'ipsita', 'jayashree', 'jaya', 'kakoli', 'koyel', 'mahasweta',
  'mahua', 'mala', 'mallika', 'mampi', 'manasi', 'mausumi', 'mimi', 'mitali', 'moushumi',
  'nandini', 'oindrila', 'paromita', 'piyali', 'purba', 'rangana', 'rimjhim', 'ritwika',
  'rupsa', 'sagarika', 'sharmistha', 'sohini', 'srabani', 'srijita', 'sriparna', 'suchitra',
  'sudeshna', 'sukanya', 'sulagna', 'sutapa', 'swagata', 'tanushree', 'tiyasha', 'trina',
  // Gujarati / Marathi
  'aarti', 'anushka', 'bhavika', 'bhoomi', 'chaitali', 'darshana', 'devanshi', 'dhara',
  'foram', 'heena', 'hetal', 'jinal', 'kajal', 'khyati', 'krupa', 'kruti', 'mansi',
  'meghna', 'mitali', 'mrunal', 'nayana', 'neepa', 'nidhi', 'nirali', 'nishtha', 'palak',
  'pooja', 'poorvi', 'priyal', 'rachana', 'ridhi', 'riddhi', 'rima', 'rutuja', 'shefali',
  'shraddha', 'trisha', 'urvi', 'vaishnavi', 'vidhi', 'yesha',
  // South Indian — Tamil / Telugu / Kannada / Malayalam
  'aishwarya', 'akhila', 'ambika', 'ammu', 'anitha', 'anjana', 'anjali', 'anjaneyulu',
  'anupama', 'anushka', 'aparna', 'archana', 'aruna', 'arundhati', 'bhagya', 'bhagyalakshmi',
  'bhanu', 'bhanumathi', 'bharathi', 'bhavana', 'bhavani', 'chaitra', 'chandana', 'chandrika',
  'deepa', 'deepika', 'devayani', 'devi', 'dhanalakshmi', 'dhanya', 'divya', 'gayathri',
  'gayatri', 'geetha', 'gowri', 'harini', 'indira', 'jaya', 'jayalakshmi', 'jayanthi',
  'kalyani', 'kamakshi', 'kaveri', 'keerthana', 'keerthi', 'kalpana', 'lakshmi', 'lalitha',
  'latha', 'lavanya', 'madhavi', 'madhuri', 'mahalakshmi', 'malathi', 'malavika', 'malini',
  'mangala', 'meenakshi', 'meera', 'mythili', 'nagalakshmi', 'nandhini', 'nandini',
  'nirmala', 'padma', 'padmavathi', 'padmini', 'pallavi', 'parvathi', 'poornima', 'pramila',
  'pratibha', 'preethi', 'priya', 'priyanka', 'radhika', 'rajalakshmi', 'rajeswari',
  'ramya', 'ranjani', 'ranjitha', 'rathika', 'revathi', 'rukmini', 'sahana', 'sandhya',
  'sangeetha', 'saranya', 'saraswathi', 'sarayu', 'sarita', 'saroja', 'sasikala', 'shalini',
  'shanthi', 'sharada', 'sharmila', 'shashikala', 'shobha', 'shobhana', 'shreya', 'shruti',
  'shubha', 'shweta', 'sindhu', 'sireesha', 'sita', 'sowmya', 'sridevi', 'srilatha',
  'srividya', 'subbulakshmi', 'sudha', 'suhasini', 'sujata', 'sujatha', 'sulochana',
  'sumathi', 'suma', 'sunanda', 'sunitha', 'suvarna', 'swapna', 'swarna', 'swathi',
  'swetha', 'tanuja', 'thanuja', 'uma', 'umadevi', 'usha', 'vaishnavi', 'vaidehi', 'vani',
  'vanitha', 'varalakshmi', 'varsha', 'vasanthi', 'vasudha', 'veda', 'vidhya', 'vidya',
  'vijaya', 'vijayalakshmi', 'vimala', 'yamuna', 'yashoda', 'yamini',
  // Parsi
  'aban', 'aloo', 'avan', 'bapsy', 'dilnaz', 'freny', 'goolnar', 'homai', 'roshan',
  'shirin', 'tanaz', 'zarine',
  // Christian / Anglo-Indian / Goan / North-Eastern common
  'agnes', 'angela', 'anita', 'ann', 'anna', 'annie', 'beatrice', 'bernadette', 'carol',
  'catherine', 'celine', 'cynthia', 'diana', 'dolly', 'elizabeth', 'esther', 'flora',
  'grace', 'jasmine', 'jennifer', 'jessica', 'joanna', 'josephine', 'julia', 'juliet',
  'kristina', 'lilian', 'lily', 'lisa', 'lorna', 'lucy', 'maria', 'marina', 'martha',
  'mary', 'monica', 'nancy', 'natalie', 'nicole', 'nirmala', 'olivia', 'pearl', 'philomena',
  'priscilla', 'rachel', 'rebecca', 'rosaline', 'rose', 'ruth', 'sabrina', 'sandra',
  'sarah', 'sharon', 'stella', 'susan', 'sylvia', 'teresa', 'theresa', 'veronica', 'vinita',
  'wendy',
]);

// Names deliberately excluded from BOTH sets above despite appearing common —
// genuinely used for both genders often enough in India that a forced tag
// would be wrong too often to be useful. Listed explicitly so it's clear
// these are a considered omission, not an oversight.
const KNOWN_AMBIGUOUS = new Set([
  'kiran', 'simran', 'amanpreet', 'manpreet', 'jaspreet', 'harpreet', 'gurpreet',
  'sukhpreet', 'rupinder', 'amandeep', 'baljeet', 'chandra', 'krishna',
]);

// High-confidence suffix fallback for names the dictionary doesn't cover —
// deliberately short. Applied only when the whole name isn't in either
// dictionary set or the ambiguous set above.
const FEMININE_SUFFIXES = ['ika', 'itha', 'ita', 'ini', 'ee', 'aa'];
const MASCULINE_SUFFIXES = ['esh', 'endra', 'eshwar', 'eswar', 'endar', 'vardhan', 'kumar'];

function matchesSuffix(name: string, suffixes: string[]): boolean {
  return suffixes.some(s => name.endsWith(s));
}

/**
 * Classifies a candidate's likely gender from their first name. Returns null
 * ("Unknown") rather than guessing when the name isn't recognized or is a
 * known-ambiguous/unisex name — see the module header for why that's the
 * deliberate, correct behavior here, not a gap to close later.
 */
export function classifyGender(fullName: string | null | undefined): Gender | null {
  const firstName = extractFirstName(fullName);
  if (!firstName) return null;

  if (KNOWN_AMBIGUOUS.has(firstName)) return null;
  if (MALE_NAMES.has(firstName)) return 'M';
  if (FEMALE_NAMES.has(firstName)) return 'F';

  // Suffix fallback — feminine checked first since it's the more reliable of
  // the two short lists; an unrecognized name matching neither returns null.
  if (matchesSuffix(firstName, FEMININE_SUFFIXES)) return 'F';
  if (matchesSuffix(firstName, MASCULINE_SUFFIXES)) return 'M';

  return null;
}
